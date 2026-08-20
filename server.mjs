import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const defaultRoot = process.cwd();
const basePort = Number.parseInt(process.env.PORT || "5173", 10);
const localNetwork = inspectLocalNetwork();
const requestedBindHost = process.env.UTH_BIND || process.env.HOST || "127.0.0.1";
const resolvedBind = resolveBindHost(requestedBindHost, localNetwork);
const bindHost = resolvedBind.host;
const bindMode = resolvedBind.mode;
const explicitPublicUrl = process.env.UTH_PUBLIC_URL || process.env.UTH_FUNNEL_URL || "";
const tailscaleCertDomain = process.env.TS_CERT_DOMAIN || "";
const maxBodyBytes = 3 * 1024 * 1024;
const maxOutputBytes = 2 * 1024 * 1024;
const textLimit = 220_000;
const allowedAgentPaths = new Set([
  "/api/health",
  "/api/browse-folders",
  "/api/list-files",
  "/api/read-file",
  "/api/compile",
  "/api/save-trace",
  "/api/process"
]);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"]
]);

const sourceExtensions = new Set([
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".m",
  ".mm",
  ".rs",
  ".go",
  ".js",
  ".ts",
  ".py",
  ".swift"
]);

const cKeywords = new Set([
  "if",
  "for",
  "while",
  "switch",
  "return",
  "sizeof",
  "do",
  "case",
  "else",
  "typedef",
  "struct"
]);

function json(res, statusCode, value) {
  const payload = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(payload);
}

function text(res, statusCode, value, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(value);
}

function notFound(res) {
  json(res, 404, { ok: false, error: "Not found" });
}

function normalizeIncomingPath(value, fallback = defaultRoot) {
  const input = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (input.includes("\0")) {
    throw new Error("Path contains a null byte.");
  }
  return path.resolve(input.replace(/^~(?=$|\/)/, os.homedir()));
}

function safeBasename(value, fallback = "snippet.c") {
  const candidate = path.basename(value || fallback).replace(/[^\w.-]/g, "_");
  return candidate.endsWith(".c") ? candidate : `${candidate || "snippet"}.c`;
}

function safePythonBasename(value, fallback = "snippet.py") {
  const candidate = path.basename(value || fallback).replace(/[^\w.-]/g, "_");
  return candidate.endsWith(".py") ? candidate : `${candidate || "snippet"}.py`;
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function truncateText(value, limit = textLimit) {
  if (!value) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n... truncated ${value.length - limit} characters ...`;
}

async function readTextFileLimited(filePath) {
  const buffer = await readFile(filePath);
  const textValue = buffer.toString("utf8");
  return truncateText(textValue);
}

async function serveStatic(req, res) {
  const parsed = new URL(req.url, "http://localhost");
  const decoded = decodeURIComponent(parsed.pathname);
  const requestedPath = decoded === "/" ? "/index.html" : decoded;
  const target = path.resolve(publicDir, `.${requestedPath}`);

  if (!target.startsWith(publicDir)) {
    notFound(res);
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) {
      notFound(res);
      return;
    }
    const body = await readFile(target);
    const ext = path.extname(target);
    res.writeHead(200, {
      "content-type": mimeTypes.get(ext) || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch {
    notFound(res);
  }
}

function runCommand(command, args, options = {}) {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 12_000;
  const cwd = options.cwd ?? defaultRoot;

  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let didTimeout = false;
    let didOverflow = false;

    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        LC_ALL: "C"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      didTimeout = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const collect = (current, chunk) => {
      if (current.length >= maxOutputBytes) {
        didOverflow = true;
        return current;
      }
      const next = Buffer.concat([current, chunk]);
      if (next.length > maxOutputBytes) {
        didOverflow = true;
        return next.subarray(0, maxOutputBytes);
      }
      return next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = collect(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = collect(stderr, chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command,
        args,
        code: -1,
        ok: false,
        durationMs: Date.now() - started,
        stdout: stdout.toString("utf8"),
        stderr: `${stderr.toString("utf8")}${error.message}`,
        didTimeout,
        didOverflow
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        args,
        code,
        signal,
        ok: code === 0 && !didTimeout,
        durationMs: Date.now() - started,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        didTimeout,
        didOverflow
      });
    });

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

async function commandExists(command) {
  const result = await runCommand("/usr/bin/which", [command], { timeoutMs: 2_000 });
  return result.ok ? result.stdout.trim() : "";
}

async function fileExists(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function findNearestProjectRoot(startPath) {
  let current = normalizeIncomingPath(startPath || defaultRoot);
  try {
    const info = await stat(current);
    if (info.isFile()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    if (await fileExists(path.join(current, "pyproject.toml")) || await fileExists(path.join(current, "uv.lock"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

async function findTailscaleCli() {
  const fromPath = await commandExists("tailscale");
  if (fromPath) return fromPath;

  const candidates = [
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale"
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep looking through common install locations.
    }
  }
  return "";
}

function stripIpv6Brackets(hostname) {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function formatHostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function inspectLocalNetwork() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  const tailscale = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (!entry.address || entry.internal) continue;
      const family = typeof entry.family === "string" ? entry.family : `IPv${entry.family}`;
      const row = {
        interface: name,
        address: entry.address,
        family,
        netmask: entry.netmask || ""
      };
      addresses.push(row);
      if (isTailscaleHost(entry.address)) {
        tailscale.push(row);
      }
    }
  }

  tailscale.sort((a, b) => {
    if (a.family === b.family) return a.address.localeCompare(b.address);
    return a.family === "IPv4" ? -1 : 1;
  });

  return {
    addresses,
    tailscale,
    tailscaleIpv4: tailscale.find((entry) => entry.family === "IPv4")?.address || "",
    tailscaleIpv6: tailscale.find((entry) => entry.family === "IPv6")?.address || ""
  };
}

function resolveBindHost(requested, network) {
  const normalized = String(requested || "").trim().toLowerCase();
  if (normalized === "tailnet" || normalized === "tailscale") {
    const host = network.tailscaleIpv4 || network.tailscaleIpv6;
    if (host) {
      return { host, mode: "tailnet" };
    }
    return {
      host: "127.0.0.1",
      mode: "localhost",
      warning: "No Tailscale interface was detected; falling back to localhost."
    };
  }

  if (normalized === "all") {
    return { host: "0.0.0.0", mode: "all" };
  }

  if (normalized === "localhost") {
    return { host: "127.0.0.1", mode: "localhost" };
  }

  if (!normalized) {
    return { host: "127.0.0.1", mode: "localhost" };
  }

  return {
    host: requested,
    mode: isTailscaleHost(requested) ? "tailnet" : isLoopbackHost(requested) ? "localhost" : "custom"
  };
}

async function buildBrowserUrls(port) {
  const local = `http://127.0.0.1:${port}`;
  const tailnetHost = localNetwork.tailscaleIpv4 || localNetwork.tailscaleIpv6;
  const tailnet = tailnetHost ? `http://${formatHostForUrl(tailnetHost)}:${port}` : "";
  const bound = `http://${formatHostForUrl(bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost)}:${port}`;
  const funnel = await detectFunnel(port);
  const publicUrl = funnel.primaryUrl;

  return {
    local,
    tailnet,
    bound,
    funnel: funnel.primaryUrl,
    funnelUrls: funnel.urls,
    funnelSource: funnel.source,
    funnelMessage: funnel.message,
    public: publicUrl,
    advertised: publicUrl || (bindMode === "tailnet" ? tailnet : bindMode === "all" ? tailnet || local : bound)
  };
}

async function detectFunnel(port) {
  const envUrl = normalizeOptionalPublicUrl(explicitPublicUrl);
  if (envUrl) {
    return {
      primaryUrl: envUrl,
      urls: [envUrl],
      source: process.env.UTH_FUNNEL_URL ? "UTH_FUNNEL_URL" : "UTH_PUBLIC_URL",
      message: "Using the configured public URL."
    };
  }

  if (tailscaleCertDomain) {
    const url = normalizeOptionalPublicUrl(`https://${tailscaleCertDomain}`);
    if (url) {
      return {
        primaryUrl: url,
        urls: [url],
        source: "TS_CERT_DOMAIN",
        message: "Using the Tailscale certificate domain from the environment."
      };
    }
  }

  const tailscalePath = await findTailscaleCli();
  if (!tailscalePath) {
    return {
      primaryUrl: "",
      urls: [],
      source: "none",
      message: "The tailscale CLI is not available, so Funnel status cannot be read automatically."
    };
  }

  for (const command of ["funnel", "serve"]) {
    const result = await runCommand(tailscalePath, [command, "status", "--json"], {
      timeoutMs: 5_000
    });
    if (!result.ok || !result.stdout.trim()) continue;

    try {
      const status = JSON.parse(result.stdout);
      const urls = extractFunnelUrls(status, port);
      if (urls.length) {
        return {
          primaryUrl: urls[0],
          urls,
          source: `tailscale ${command} status --json`,
          message: `Detected ${urls.length} Funnel URL${urls.length === 1 ? "" : "s"}.`
        };
      }
    } catch {
      // Older or unexpected CLI output should not break the viewer.
    }
  }

  return {
    primaryUrl: "",
    urls: [],
    source: "tailscale status",
    message: "No matching Funnel URL was found for this viewer port."
  };
}

function normalizeOptionalPublicUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const raw = value.trim();
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    url.pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function extractFunnelUrls(config, localPort) {
  const matches = [];
  const fallbacks = [];
  const seen = new Set();

  function addUrl(sourceConfig, hostPort, mount = "/", target = "") {
    if (!hostPort || !isFunnelAllowed(sourceConfig, hostPort)) return;
    const parsed = parseHostPort(hostPort);
    if (!parsed.host) return;
    const url = buildFunnelUrl(parsed.host, parsed.port, mount);
    if (!url || seen.has(url)) return;
    seen.add(url);

    const row = {
      url,
      score: proxyTargetsPort(target, localPort) ? 0 : 1
    };
    if (row.score === 0) {
      matches.push(row);
    } else {
      fallbacks.push(row);
    }
  }

  collectFunnelUrlsFromConfig(config, addUrl);
  for (const foreground of Object.values(config?.Foreground || {})) {
    collectFunnelUrlsFromConfig(foreground, addUrl);
  }
  for (const service of Object.values(config?.Services || {})) {
    collectFunnelUrlsFromConfig(service, addUrl);
  }

  return [...matches, ...fallbacks].map((row) => row.url);
}

function collectFunnelUrlsFromConfig(config, addUrl) {
  for (const [hostPort, webConfig] of Object.entries(config?.Web || {})) {
    const handlers = webConfig?.Handlers || {};
    const mounts = Object.keys(handlers);
    if (!mounts.length) addUrl(config, hostPort);
    for (const [mount, handler] of Object.entries(handlers)) {
      addUrl(config, hostPort, mount, handler?.Proxy || handler?.TCPForward || "");
    }
  }

  for (const [hostPort, allowed] of Object.entries(config?.AllowFunnel || {})) {
    if (allowed) addUrl(config, hostPort);
  }
}

function isFunnelAllowed(config, hostPort) {
  const allowFunnel = config?.AllowFunnel || {};
  if (allowFunnel[hostPort] === true) return true;
  if (allowFunnel[hostPort] === false) return false;
  return Object.keys(allowFunnel).length === 0;
}

function parseHostPort(hostPort) {
  try {
    const url = new URL(`https://${hostPort}`);
    return {
      host: stripIpv6Brackets(url.hostname),
      port: Number.parseInt(url.port || "443", 10)
    };
  } catch {
    const match = String(hostPort).match(/^(.+):(\d+)$/);
    return match
      ? { host: stripIpv6Brackets(match[1]), port: Number.parseInt(match[2], 10) }
      : { host: String(hostPort), port: 443 };
  }
}

function buildFunnelUrl(host, port, mount = "/") {
  if (!host || !host.endsWith(".ts.net")) return "";
  const suffix = port && port !== 443 ? `:${port}` : "";
  const cleanMount = mount && mount !== "/" ? `/${mount.replace(/^\/+/, "").replace(/\/+$/, "")}` : "";
  return `https://${host}${suffix}${cleanMount}`;
}

function proxyTargetsPort(target, localPort) {
  if (!target || !localPort) return false;
  const normalized = String(target).trim();
  if (normalized === String(localPort)) return true;

  try {
    const url = new URL(normalized.includes("://") ? normalized : `http://${normalized}`);
    return Number.parseInt(url.port || (url.protocol === "https:" ? "443" : "80"), 10) === localPort;
  } catch {
    return normalized.endsWith(`:${localPort}`);
  }
}

function parseIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet, index) => !/^\d+$/.test(parts[index]) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function isLoopbackHost(hostname) {
  const host = stripIpv6Brackets(hostname);
  const octets = parseIpv4(host);
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    Boolean(octets && octets[0] === 127)
  );
}

function isTailscaleHost(hostname) {
  const host = stripIpv6Brackets(hostname);
  const octets = parseIpv4(host);
  if (octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
    return true;
  }
  return host.startsWith("fd7a:115c:a1e0:") || host.endsWith(".ts.net");
}

function normalizeAgentBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Remote target URL is required.");
  }

  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Remote target must use http or https.");
  }

  if (!isLoopbackHost(url.hostname) && !isTailscaleHost(url.hostname)) {
    throw new Error("Remote target must be localhost, a Tailscale 100.64.0.0/10 IP, Tailscale IPv6, or a .ts.net MagicDNS name.");
  }

  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function defaultAgentUrlForHost(host, port = basePort) {
  const normalized = String(host || "").replace(/\.$/, "");
  if (!normalized) return "";
  const wrapped = normalized.includes(":") && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
  return `http://${wrapped}:${port}`;
}

async function discoverTailscale() {
  const tailscalePath = await commandExists("tailscale");
  if (!tailscalePath) {
    return {
      ok: true,
      available: false,
      peers: [],
      message: "The tailscale CLI is not installed on this machine."
    };
  }

  const result = await runCommand(tailscalePath, ["status", "--json"], { timeoutMs: 5_000 });
  if (!result.ok) {
    return {
      ok: true,
      available: false,
      peers: [],
      message: truncateText(result.stderr || result.stdout || "tailscale status did not return peer data.", 12_000)
    };
  }

  const status = JSON.parse(result.stdout);
  const self = formatTailscaleNode(status.Self, "self");
  const peers = Object.entries(status.Peer || {})
    .map(([id, peer]) => formatTailscaleNode(peer, id))
    .filter(Boolean)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));

  return {
    ok: true,
    available: true,
    self,
    peers,
    message: `${peers.length} Tailnet peer${peers.length === 1 ? "" : "s"} discovered.`
  };
}

function formatTailscaleNode(node, id) {
  if (!node) return null;
  const dnsName = String(node.DNSName || "").replace(/\.$/, "");
  const addresses = Array.isArray(node.TailscaleIPs) ? node.TailscaleIPs : [];
  const host = dnsName || addresses[0] || node.HostName || "";
  return {
    id,
    name: node.HostName || dnsName || id,
    dnsName,
    addresses,
    os: node.OS || "",
    online: Boolean(node.Online),
    exitNode: Boolean(node.ExitNode),
    baseUrl: defaultAgentUrlForHost(host)
  };
}

async function proxyAgentRequest(body) {
  const apiPath = typeof body.apiPath === "string" ? body.apiPath : "";
  if (!allowedAgentPaths.has(apiPath)) {
    throw new Error("That remote API path is not available through the target proxy.");
  }

  const method = body.method === "GET" ? "GET" : "POST";
  if (method === "GET" && apiPath !== "/api/health") {
    throw new Error("Only health checks can be proxied with GET.");
  }

  const baseUrl = normalizeAgentBaseUrl(body.baseUrl);
  const targetUrl = `${baseUrl}${apiPath}`;
  const response = await fetch(targetUrl, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(body.payload || {}) : undefined,
    signal: AbortSignal.timeout(30_000)
  });
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Remote target returned non-JSON output from ${apiPath}.`);
  }

  if (!response.ok) {
    return {
      ok: false,
      remoteStatus: response.status,
      error: payload.error || `Remote target returned HTTP ${response.status}.`,
      payload
    };
  }

  return {
    ...payload,
    remote: {
      baseUrl,
      apiPath
    }
  };
}

async function listFiles(rootPath) {
  const root = normalizeIncomingPath(rootPath);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) {
    throw new Error("The selected path is not a folder.");
  }

  const files = [];
  const maxFiles = 700;
  const maxDepth = 7;
  const ignored = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
    "target",
    ".cache"
  ]);

  async function walk(dir, depth) {
    if (files.length >= maxFiles || depth > maxDepth) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
        const info = await stat(fullPath);
        files.push({
          name: entry.name,
          path: fullPath,
          rel: path.relative(root, fullPath),
          size: info.size,
          ext: path.extname(entry.name)
        });
      }
    }
  }

  await walk(root, 0);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return {
    root,
    files,
    truncated: files.length >= maxFiles
  };
}

async function directoryExists(directoryPath) {
  try {
    return (await stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

async function folderPlaces() {
  const home = os.homedir();
  const candidates = [
    ["Project", defaultRoot],
    ["Home", home],
    ["Documents", path.join(home, "Documents")],
    ["Desktop", path.join(home, "Desktop")],
    ["Downloads", path.join(home, "Downloads")],
    ["Root", path.parse(defaultRoot).root]
  ];
  const places = [];
  const seen = new Set();
  for (const [name, rawPath] of candidates) {
    const resolved = normalizeIncomingPath(rawPath);
    if (seen.has(resolved) || !(await directoryExists(resolved))) continue;
    seen.add(resolved);
    places.push({ name, path: resolved });
  }
  return places;
}

async function browseFolders(folderPath) {
  let root = normalizeIncomingPath(folderPath);
  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch (error) {
    throw new Error(`Folder not found: ${root}. ${error.message}`);
  }
  if (!rootInfo.isDirectory()) {
    root = path.dirname(root);
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read folder: ${root}. ${error.message}`);
  }

  const folders = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    let isDirectory = entry.isDirectory();
    const symlink = entry.isSymbolicLink();
    if (!isDirectory && symlink) {
      try {
        isDirectory = (await stat(fullPath)).isDirectory();
      } catch {
        isDirectory = false;
      }
    }
    if (!isDirectory) continue;
    folders.push({
      name: entry.name,
      path: fullPath,
      hidden: entry.name.startsWith("."),
      symlink
    });
  }

  folders.sort((a, b) => {
    if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  const parent = path.dirname(root);
  return {
    root,
    parent: parent === root ? "" : parent,
    entries: folders.slice(0, 500),
    places: await folderPlaces(),
    truncated: folders.length > 500
  };
}

function parseFunctions(source) {
  const definitions = [];
  const pattern =
    /(?:^|\n)\s*(?:static\s+|inline\s+|extern\s+|const\s+|unsigned\s+|signed\s+|long\s+|short\s+|void\s+|int\s+|char\s+|float\s+|double\s+|size_t\s+|uint\d+_t\s+|int\d+_t\s+|[A-Za-z_]\w+\s+|[*\s])+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/g;

  let match;
  while ((match = pattern.exec(source))) {
    const name = match[1];
    const openBrace = source.indexOf("{", match.index);
    const body = findBraceBody(source, openBrace);
    if (body) {
      definitions.push({
        name,
        start: match.index,
        end: body.end,
        calls: []
      });
    }
  }

  const defined = new Set(definitions.map((definition) => definition.name));
  for (const definition of definitions) {
    const body = source.slice(definition.start, definition.end);
    const calls = new Set();
    const callPattern = /\b([A-Za-z_]\w*)\s*\(/g;
    let callMatch;
    while ((callMatch = callPattern.exec(body))) {
      const candidate = callMatch[1];
      if (candidate !== definition.name && defined.has(candidate) && !cKeywords.has(candidate)) {
        calls.add(candidate);
      }
    }
    definition.calls = [...calls].sort();
  }

  return definitions.map(({ name, calls }) => ({ name, calls }));
}

function findBraceBody(source, openBrace) {
  if (openBrace < 0) return null;
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return { end: index + 1 };
  }
  return null;
}

function filterAssembly(assembly, functionName) {
  if (!functionName) return assembly;
  const lines = assembly.split("\n");
  const markers = [
    `${functionName}:`,
    `_${functionName}:`,
    `<${functionName}>:`,
    `<_${functionName}>:`
  ];
  const start = lines.findIndex((line) => markers.some((marker) => line.includes(marker)));
  if (start === -1) return "";

  const next = lines.findIndex((line, index) => {
    if (index <= start) return false;
    return /^[A-Za-z_.$][\w.$]*:\s*$/.test(line.trim()) || /^\w+\s+<[^>]+>:\s*$/.test(line.trim());
  });
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

function parseSymbolMap(symbolsText) {
  const byAddress = new Map();
  for (const line of symbolsText.split("\n")) {
    const match = line.match(/^([0-9a-fA-F]+)\s+\([^)]*\)\s+(?:external|non-external)\s+([A-Za-z_.$][\w.$]*)/);
    if (!match) continue;
    const name = match[2].replace(/^_/, "");
    if (/^ltmp\d+$|^l_/.test(name)) continue;
    if (!byAddress.has(match[1])) byAddress.set(match[1], name);
  }
  return byAddress;
}

function parseDisassemblyInstructions(disassembly, symbolsText = "") {
  const instructions = [];
  const lines = disassembly.split("\n");
  const symbolsByAddress = parseSymbolMap(symbolsText);
  let currentFunction = "";

  for (const line of lines) {
    const functionMatch = line.match(/^\s*([0-9a-fA-F]+)\s+<([^>]+)>:/);
    if (functionMatch) {
      currentFunction = symbolsByAddress.get(functionMatch[1]) || functionMatch[2].replace(/^_/, "");
      continue;
    }

    const instructionMatch = line.match(/^\s*([0-9a-fA-F]+):\s+([0-9a-fA-F ]{2,40})\s+(.+)$/);
    if (instructionMatch) {
      instructions.push({
        function: currentFunction,
        address: instructionMatch[1],
        bytes: instructionMatch[2].trim(),
        instruction: instructionMatch[3].trim()
      });
    }
  }

  return instructions.slice(0, 600);
}

function filterDisassembly(disassembly, functionName, symbolsText = "") {
  if (!functionName) return disassembly;
  const normalized = functionName.replace(/^_/, "");
  const symbolsByAddress = parseSymbolMap(symbolsText);
  const lines = disassembly.split("\n");
  const start = lines.findIndex((line) => {
    const match = line.match(/^\s*([0-9a-fA-F]+)\s+<([^>]+)>:/);
    if (!match) return false;
    const name = symbolsByAddress.get(match[1]) || match[2].replace(/^_/, "");
    return name === normalized;
  });
  if (start === -1) return "";
  const next = lines.findIndex((line, index) => index > start && /^\s*[0-9a-fA-F]+\s+<([^>]+)>:/.test(line));
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

function sha256Short(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

const pythonProbeSource = String.raw`import ast
import dis
import io
import json
import sys
import types

source_path = sys.argv[1]
output_path = sys.argv[2] if len(sys.argv) > 2 else ""
selected = sys.argv[3] if len(sys.argv) > 3 else ""

with open(source_path, "r", encoding="utf-8") as handle:
    source = handle.read()


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    if isinstance(node, ast.Call):
        return dotted(node.func)
    return ""


imports = []
for node in ast.walk(ast.parse(source, filename=source_path)):
    if isinstance(node, ast.Import):
        imports.extend(alias.name for alias in node.names)
    elif isinstance(node, ast.ImportFrom):
        module = "." * node.level + (node.module or "")
        imports.extend(f"{module}.{alias.name}".strip(".") for alias in node.names)


class FunctionVisitor(ast.NodeVisitor):
    def __init__(self):
        self.stack = []
        self.functions = []

    def visit_ClassDef(self, node):
        self.stack.append(node.name)
        self.generic_visit(node)
        self.stack.pop()

    def visit_FunctionDef(self, node):
        self._visit_function(node, "function")

    def visit_AsyncFunctionDef(self, node):
        self._visit_function(node, "async function")

    def _visit_function(self, node, kind):
        qualname = ".".join([*self.stack, node.name])
        calls = sorted({
            dotted(call.func)
            for call in ast.walk(node)
            if isinstance(call, ast.Call) and dotted(call.func)
        })
        self.functions.append({
            "name": node.name,
            "qualname": qualname,
            "kind": kind,
            "lineno": node.lineno,
            "end_lineno": getattr(node, "end_lineno", node.lineno),
            "calls": calls,
        })
        self.stack.append(node.name)
        self.generic_visit(node)
        self.stack.pop()


tree = ast.parse(source, filename=source_path)
visitor = FunctionVisitor()
visitor.visit(tree)
module_code = compile(source, source_path, "exec")


def walk_code(code, prefix=""):
    name = code.co_name if code.co_name != "<module>" else "<module>"
    qualname = f"{prefix}.{name}" if prefix and name != "<module>" else name
    yield qualname, code
    for const in code.co_consts:
        if isinstance(const, types.CodeType):
            child_prefix = qualname if qualname != "<module>" else ""
            yield from walk_code(const, child_prefix)


code_objects = list(walk_code(module_code))
visible_code_objects = [
    (qualname, code)
    for qualname, code in code_objects
    if not selected or code.co_name == selected or qualname.endswith(f".{selected}")
]
if selected and not visible_code_objects:
    visible_code_objects = code_objects

rows = []
disassembly_parts = []
for qualname, code in visible_code_objects:
    buffer = io.StringIO()
    dis.dis(code, file=buffer)
    disassembly_parts.append(f"# {qualname}\n{buffer.getvalue().rstrip()}")
    for instruction in dis.get_instructions(code):
        rows.append({
            "function": code.co_name if code.co_name != "<module>" else "<module>",
            "qualname": qualname,
            "address": str(instruction.offset),
            "bytes": f"opcode {instruction.opcode}",
            "instruction": f"{instruction.opname} {instruction.argrepr}".strip(),
            "line": instruction.starts_line,
        })

symbols = []
for qualname, code in code_objects:
    symbols.append({
        "qualname": qualname,
        "argcount": code.co_argcount,
        "locals": list(code.co_varnames),
        "names": list(code.co_names),
        "freevars": list(code.co_freevars),
        "cellvars": list(code.co_cellvars),
    })

payload = {
    "functions": visitor.functions,
    "imports": sorted(set(imports)),
    "ast": ast.dump(tree, indent=2, include_attributes=False),
    "disassembly": "\n\n".join(disassembly_parts),
    "instructionRows": rows[:1200],
    "symbols": symbols,
}

if output_path:
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
else:
    print(json.dumps(payload, indent=2))
`;

async function analyzePythonSource(body) {
  const source = typeof body.source === "string" ? body.source : "";
  if (!source.trim()) {
    throw new Error("Source is empty.");
  }

  const sourcePath = typeof body.sourcePath === "string" && body.sourcePath.trim()
    ? normalizeIncomingPath(body.sourcePath)
    : "";
  const projectRoot = await findNearestProjectRoot(sourcePath || body.root || defaultRoot);
  const uvPath = projectRoot ? await commandExists("uv") : "";
  const python3Path = await commandExists("python3");
  const pythonPath = python3Path || await commandExists("python");
  const workDir = await mkdtemp(path.join(os.tmpdir(), "uth-python-"));
  const sourceName = safePythonBasename(body.fileName || sourcePath, "snippet.py");
  const tempSourcePath = path.join(workDir, sourceName);
  const probePath = path.join(workDir, "python_probe.py");
  const probeOutputPath = path.join(workDir, "python_probe_output.json");
  const functionName = typeof body.functionName === "string" ? body.functionName.trim() : "";

  await writeFile(tempSourcePath, source, "utf8");
  await writeFile(probePath, pythonProbeSource, "utf8");

  const stages = [];
  async function stage(id, label, command, args, options = {}) {
    const result = await runCommand(command, args, {
      cwd: options.cwd || projectRoot || workDir,
      timeoutMs: options.timeoutMs || 12_000
    });
    stages.push({
      id,
      label,
      command: [command, ...args].join(" "),
      ok: result.ok,
      code: result.code,
      durationMs: result.durationMs,
      stdout: truncateText(result.stdout, 18_000),
      stderr: truncateText(result.stderr, 18_000),
      didTimeout: result.didTimeout
    });
    return result;
  }

  let runner = null;
  let runnerArgs = [];
  let runnerCwd = projectRoot || workDir;
  let runnerLabel = "Python";
  if (uvPath && projectRoot) {
    runner = uvPath;
    runnerArgs = ["run", "--no-sync", "python"];
    runnerLabel = "uv run python";
  } else if (pythonPath) {
    runner = pythonPath;
  } else {
    throw new Error("No Python interpreter was found.");
  }

  stages.push({
    id: "project",
    label: "Project",
    command: projectRoot ? `project root ${projectRoot}` : "temporary source",
    ok: true,
    code: 0,
    durationMs: 0,
    stdout: projectRoot || workDir,
    stderr: "",
    didTimeout: false
  });

  const analysis = await stage("bytecode", runnerLabel, runner, [
    ...runnerArgs,
    probePath,
    tempSourcePath,
    probeOutputPath,
    functionName
  ], {
    cwd: runnerCwd,
    timeoutMs: 15_000
  });

  if (!analysis.ok) {
    return {
      ok: false,
      language: "python",
      workDir,
      stages,
      error: "Python analysis failed before bytecode artifacts could be produced.",
      project: {
        root: projectRoot,
        usesUv: Boolean(uvPath && projectRoot),
        uvPath,
        sourcePath: sourcePath || ""
      }
    };
  }

  const probeOutput = await readFile(probeOutputPath, "utf8");
  const payload = JSON.parse(probeOutput);
  stages.push(
    {
      id: "ast",
      label: "AST parse",
      command: "ast.parse",
      ok: true,
      code: 0,
      durationMs: 0,
      stdout: `${(payload.functions || []).length} function definitions`,
      stderr: "",
      didTimeout: false
    },
    {
      id: "compile",
      label: "Code object",
      command: "compile(..., 'exec')",
      ok: true,
      code: 0,
      durationMs: 0,
      stdout: `${(payload.symbols || []).length} code objects`,
      stderr: "",
      didTimeout: false
    },
    {
      id: "imports",
      label: "Imports",
      command: "AST import scan",
      ok: true,
      code: 0,
      durationMs: 0,
      stdout: `${(payload.imports || []).length} imports`,
      stderr: "",
      didTimeout: false
    }
  );

  let dependencyTree = null;
  if (uvPath && projectRoot) {
    dependencyTree = await stage("dependencies", "uv dependencies", uvPath, [
      "tree",
      "--depth",
      "1"
    ], {
      cwd: projectRoot,
      timeoutMs: 12_000
    });
  }

  const functions = payload.functions || [];
  const callGraph = functions.map((fn) => ({
    from: fn.qualname || fn.name,
    to: fn.calls || []
  }));
  const symbolText = (payload.symbols || [])
    .map((symbol) => [
      `${symbol.qualname}(`,
      `  args: ${symbol.argcount}`,
      `  locals: ${(symbol.locals || []).join(", ") || "(none)"}`,
      `  names: ${(symbol.names || []).join(", ") || "(none)"}`,
      `  freevars: ${(symbol.freevars || []).join(", ") || "(none)"}`,
      `)`
    ].join("\n"))
    .join("\n\n");
  const dependencyText = dependencyTree
    ? `uv project: ${projectRoot}\nuv: ${uvPath}\n\n${dependencyTree.stdout || dependencyTree.stderr || "No dependency tree output."}`
    : `project: ${projectRoot || "(none)"}\nuv: ${uvPath || "(not used)"}\npython: ${pythonPath || runner}`;
  const stageOrder = ["project", "ast", "compile", "bytecode", "imports", "dependencies"];
  const orderedStages = [
    ...stageOrder.map((id) => stages.find((item) => item.id === id)).filter(Boolean),
    ...stages.filter((item) => !stageOrder.includes(item.id))
  ];

  return {
    ok: true,
    language: "python",
    sourceHash: sha256Short(source),
    platform: {
      os: process.platform,
      arch: process.arch,
      python: stages.find((item) => item.id === "bytecode")?.command || runnerLabel
    },
    workDir,
    functionName,
    stages: orderedStages,
    project: {
      root: projectRoot,
      usesUv: Boolean(uvPath && projectRoot),
      uvPath,
      sourcePath: sourcePath || ""
    },
    source: {
      functions,
      callGraph
    },
    artifacts: {
      bytecode: truncateText(payload.disassembly || ""),
      assembly: truncateText(payload.disassembly || ""),
      disassembly: truncateText(payload.disassembly || ""),
      llvmIr: truncateText(payload.ast || ""),
      ast: truncateText(payload.ast || ""),
      symbols: truncateText(`${dependencyText}\n\nImports:\n${(payload.imports || []).join("\n") || "(none)"}\n\nCode objects:\n${symbolText}`),
      instructionRows: payload.instructionRows || [],
      objectBytes: 0,
      executableBytes: 0
    },
    notes: [
      "Python source compiles to CPython bytecode for a virtual machine, not native machine code in this view.",
      "uv is used when a nearby pyproject.toml or uv.lock is found, so the analyzer runs from the selected service's project context.",
      "The analyzer parses and compiles the file without importing the module, avoiding import-time side effects."
    ]
  };
}

async function compileSource(body) {
  const source = typeof body.source === "string" ? body.source : "";
  if (!source.trim()) {
    throw new Error("Source is empty.");
  }

  const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath : "";
  const languageHint = typeof body.language === "string" ? body.language.toLowerCase() : "";
  const ext = path.extname(sourcePath || body.fileName || "").toLowerCase();
  if (languageHint === "python" || ext === ".py") {
    return analyzePythonSource(body);
  }

  const optimize = ["-O0", "-O1", "-O2", "-O3", "-Os"].includes(body.optimize)
    ? body.optimize
    : "-O0";
  const functionName = typeof body.functionName === "string" ? body.functionName.trim() : "";
  const workDir = await mkdtemp(path.join(os.tmpdir(), "uth-compile-"));
  const sourceName = safeBasename(body.fileName, "snippet.c");
  const cSourcePath = path.join(workDir, sourceName);
  const preprocessedPath = path.join(workDir, "source.i");
  const llvmPath = path.join(workDir, "source.ll");
  const assemblyPath = path.join(workDir, "source.s");
  const objectPath = path.join(workDir, "source.o");
  const executablePath = path.join(workDir, "program");

  await writeFile(cSourcePath, source, "utf8");

  const stages = [];
  async function stage(id, label, command, args, timeoutMs = 12_000) {
    const result = await runCommand(command, args, { cwd: workDir, timeoutMs });
    stages.push({
      id,
      label,
      command: [command, ...args].join(" "),
      ok: result.ok,
      code: result.code,
      durationMs: result.durationMs,
      stdout: truncateText(result.stdout, 18_000),
      stderr: truncateText(result.stderr, 18_000),
      didTimeout: result.didTimeout
    });
    return result;
  }

  const preprocessed = await stage("preprocess", "Preprocess", "clang", [
    "-E",
    cSourcePath,
    "-o",
    preprocessedPath
  ]);
  if (!preprocessed.ok) return compileFailure(stages, workDir);

  const llvm = await stage("llvm", "LLVM IR", "clang", [
    "-S",
    "-emit-llvm",
    optimize,
    cSourcePath,
    "-o",
    llvmPath
  ]);
  if (!llvm.ok) return compileFailure(stages, workDir);

  const assembly = await stage("assembly", "Assembly", "clang", [
    "-S",
    optimize,
    "-g",
    "-fverbose-asm",
    cSourcePath,
    "-o",
    assemblyPath
  ]);
  if (!assembly.ok) return compileFailure(stages, workDir);

  const object = await stage("object", "Object file", "clang", [
    "-c",
    optimize,
    "-g",
    cSourcePath,
    "-o",
    objectPath
  ]);
  if (!object.ok) return compileFailure(stages, workDir);

  const executable = await stage("link", "Executable", "clang", [
    optimize,
    "-g",
    cSourcePath,
    "-o",
    executablePath
  ]);
  if (!executable.ok) return compileFailure(stages, workDir);

  let disassembler = "objdump";
  let disassembly = await stage("disassemble", "Disassemble", "objdump", ["-d", objectPath]);
  if (!disassembly.ok) {
    disassembler = "otool";
    disassembly = await stage("disassemble-otool", "Disassemble", "otool", ["-tvV", objectPath]);
  }

  const symbols = await stage("symbols", "Symbols", "nm", ["-nm", objectPath]);

  const rawAssembly = await readTextFileLimited(assemblyPath);
  const rawDisassembly = disassembly.stdout || disassembly.stderr || "";
  const rawSymbols = symbols.stdout || symbols.stderr || "";
  const filteredAssembly = filterAssembly(rawAssembly, functionName);
  const filteredDisassembly = filterDisassembly(rawDisassembly, functionName, rawSymbols);
  const functions = parseFunctions(source);
  const instructionRows = parseDisassemblyInstructions(rawDisassembly, rawSymbols);
  const objectInfo = statSync(objectPath);
  const executableInfo = statSync(executablePath);

  return {
    ok: true,
    sourceHash: sha256Short(source),
    platform: {
      os: process.platform,
      arch: process.arch,
      clang: (await runCommand("clang", ["--version"], { timeoutMs: 3_000 })).stdout
        .split("\n")
        .slice(0, 2)
        .join("\n")
    },
    workDir,
    optimize,
    functionName,
    disassembler,
    stages,
    source: {
      functions,
      callGraph: functions.map((fn) => ({ from: fn.name, to: fn.calls }))
    },
    artifacts: {
      preprocessed: await readTextFileLimited(preprocessedPath),
      llvmIr: await readTextFileLimited(llvmPath),
      assembly: rawAssembly,
      assemblyFiltered: filteredAssembly,
      disassembly: truncateText(rawDisassembly),
      disassemblyFiltered: truncateText(filteredDisassembly),
      symbols: truncateText(rawSymbols),
      instructionRows,
      objectBytes: objectInfo.size,
      executableBytes: executableInfo.size
    },
    notes: [
      "Addresses in the object disassembly are section offsets, not final runtime virtual addresses.",
      "Runtime addresses are chosen by the loader when the executable starts, with ASLR usually enabled.",
      "Optimizations can inline or remove functions, so use -O0 when you want the source structure to remain visible."
    ]
  };
}

function compileFailure(stages, workDir) {
  return {
    ok: false,
    workDir,
    stages,
    error: "The compiler stopped before all artifacts could be produced."
  };
}

function hexDump(buffer, width = 16) {
  const rows = [];
  for (let offset = 0; offset < buffer.length; offset += width) {
    const slice = buffer.subarray(offset, offset + width);
    const hex = [...slice].map((byte) => byte.toString(16).padStart(2, "0"));
    const ascii = [...slice]
      .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "."))
      .join("");
    rows.push({
      offset,
      hex: hex.join(" "),
      ascii
    });
  }
  return rows;
}

async function saveTrace(body) {
  const source = typeof body.source === "string" ? body.source : "";
  if (!source.trim()) {
    throw new Error("Source is empty.");
  }

  const optimize = ["-O0", "-O1", "-O2", "-O3", "-Os"].includes(body.optimize)
    ? body.optimize
    : "-O0";
  const workDir = await mkdtemp(path.join(os.tmpdir(), "uth-save-"));
  const sourcePath = path.join(workDir, "save_probe.c");
  const executablePath = path.join(workDir, "save_probe");
  const requestedPath = typeof body.savePath === "string" && body.savePath.trim()
    ? body.savePath.trim()
    : path.join(workDir, "save-output.bin");
  const savePath = path.resolve(requestedPath.replace(/^~(?=$|\/)/, os.homedir()));
  const useDtruss = body.useDtruss === true;

  await mkdir(path.dirname(savePath), { recursive: true });
  await writeFile(sourcePath, source, "utf8");

  const compile = await runCommand("clang", [optimize, "-g", sourcePath, "-o", executablePath], {
    cwd: workDir,
    timeoutMs: 12_000
  });
  if (!compile.ok) {
    return {
      ok: false,
      phase: "compile",
      workDir,
      compile
    };
  }

  let syscallTrace = null;
  let run;
  if (useDtruss && process.platform === "darwin") {
    syscallTrace = await runCommand("dtruss", ["-f", executablePath, savePath], {
      cwd: workDir,
      timeoutMs: 8_000
    });
    if (syscallTrace.ok) {
      run = {
        ok: true,
        code: syscallTrace.code,
        stdout: syscallTrace.stdout,
        stderr: ""
      };
    }
  }

  if (!run) {
    run = await runCommand(executablePath, [savePath], {
      cwd: workDir,
      timeoutMs: 6_000
    });
  }

  let fileInfo = null;
  let dump = [];
  let readError = "";
  try {
    const info = await stat(savePath);
    const bytes = await readFile(savePath);
    const visibleBytes = bytes.subarray(0, 4096);
    fileInfo = {
      path: savePath,
      size: info.size,
      mode: `0${(info.mode & 0o777).toString(8)}`,
      mtime: info.mtime.toISOString(),
      blocks: info.blocks,
      blockSize: info.blksize
    };
    dump = hexDump(visibleBytes);
  } catch (error) {
    readError = error.message;
  }

  const stdout = run.stdout || "";
  const virtualAddressLines = stdout
    .split("\n")
    .filter((line) => /address|0x[0-9a-fA-F]+/.test(line))
    .slice(0, 20);

  return {
    ok: run.ok && Boolean(fileInfo),
    workDir,
    optimize,
    compile: {
      ok: compile.ok,
      durationMs: compile.durationMs,
      stderr: truncateText(compile.stderr, 12_000)
    },
    run: {
      ok: run.ok,
      code: run.code,
      durationMs: run.durationMs,
      stdout: truncateText(run.stdout, 24_000),
      stderr: truncateText(run.stderr, 24_000)
    },
    syscallTrace: syscallTrace
      ? {
          ok: syscallTrace.ok,
          code: syscallTrace.code,
          stdout: truncateText(syscallTrace.stdout, 36_000),
          stderr: truncateText(syscallTrace.stderr, 36_000)
        }
      : null,
    file: fileInfo,
    readError,
    virtualAddressLines,
    hexDump: dump,
    layers: [
      {
        name: "Program memory",
        evidence: virtualAddressLines.length
          ? "The program printed virtual addresses for stack or buffer data."
          : "No virtual addresses were printed by this program."
      },
      {
        name: "C runtime",
        evidence: "fopen/fwrite/fflush/fclose or write-style calls package bytes for the kernel."
      },
      {
        name: "Kernel filesystem path",
        evidence: fileInfo ? `The saved file is visible at ${fileInfo.path}.` : readError
      },
      {
        name: "File offsets",
        evidence: fileInfo ? `${fileInfo.size} bytes are inspectable by offset in the hex table.` : "No file bytes were read."
      },
      {
        name: "Physical media",
        evidence:
          "Physical flash pages or disk sectors are below the filesystem and device layers, so this viewer reports file offsets instead."
      }
    ]
  };
}

function parseVmmap(raw) {
  const rows = [];
  const counts = new Map();
  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith("====") || trimmed.startsWith("Process:")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_ .:/()[\]-]+)\s+([0-9a-fA-Fx`-]+)\s+\[\s*([^\]]+)\]/);
    if (!match) continue;
    const region = match[1].trim();
    rows.push({
      region,
      range: match[2],
      size: match[3].trim(),
      raw: trimmed
    });
    counts.set(region, (counts.get(region) || 0) + 1);
  }

  return {
    rows: rows.slice(0, 220),
    histogram: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([region, count]) => ({ region, count }))
  };
}

async function inspectProcess(body) {
  const pid = Number.parseInt(String(body.pid || ""), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("Enter a valid PID.");
  }

  const [ps, vmmapPath, lsofPath] = await Promise.all([
    runCommand("ps", ["-p", String(pid), "-o", "pid,ppid,state,comm,args"], { timeoutMs: 3_000 }),
    commandExists("vmmap"),
    commandExists("lsof")
  ]);

  const vmmap = vmmapPath
    ? await runCommand(vmmapPath, [String(pid)], { timeoutMs: 5_000 })
    : { ok: false, stdout: "", stderr: "vmmap is not installed." };
  const lsof = lsofPath
    ? await runCommand(lsofPath, ["-p", String(pid)], { timeoutMs: 5_000 })
    : { ok: false, stdout: "", stderr: "lsof is not installed." };

  return {
    ok: ps.ok,
    pid,
    ps: {
      ok: ps.ok,
      stdout: truncateText(ps.stdout, 20_000),
      stderr: truncateText(ps.stderr, 20_000)
    },
    vmmap: {
      ok: vmmap.ok,
      stdout: truncateText(vmmap.stdout, 80_000),
      stderr: truncateText(vmmap.stderr, 30_000),
      parsed: parseVmmap(vmmap.stdout || "")
    },
    lsof: {
      ok: lsof.ok,
      stdout: truncateText(lsof.stdout, 60_000),
      stderr: truncateText(lsof.stderr, 30_000)
    },
    notes: [
      "This is a read-only process inspection, not function-call tracing.",
      "For live function call following, the next layer would use lldb, dtrace, or eBPF-style probes with symbols and OS permission handling.",
      "Memory-map addresses are virtual addresses in that process, not physical RAM locations."
    ]
  };
}

async function routeApi(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health") {
      const browserUrls = await buildBrowserUrls(activePort);
      json(res, 200, {
        ok: true,
        root: defaultRoot,
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        bindHost,
        bindMode,
        requestedBindHost,
        advertiseUrl: explicitPublicUrl,
        browserUrls,
        tailscale: localNetwork.tailscale,
        warning: resolvedBind.warning || ""
      });
      return;
    }

    if (req.method !== "POST") {
      notFound(res);
      return;
    }

    const body = await readRequestBody(req);
    if (url.pathname === "/api/tailscale/status") {
      json(res, 200, await discoverTailscale());
      return;
    }

    if (url.pathname === "/api/agent/proxy") {
      json(res, 200, await proxyAgentRequest(body));
      return;
    }

    if (url.pathname === "/api/browse-folders") {
      json(res, 200, { ok: true, ...(await browseFolders(body.path || body.root)) });
      return;
    }

    if (url.pathname === "/api/list-files") {
      json(res, 200, { ok: true, ...(await listFiles(body.root)) });
      return;
    }

    if (url.pathname === "/api/read-file") {
      const filePath = normalizeIncomingPath(body.path);
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("The selected path is not a file.");
      if (info.size > 1_500_000) throw new Error("File is too large for the editor.");
      json(res, 200, {
        ok: true,
        path: filePath,
        name: path.basename(filePath),
        source: await readTextFileLimited(filePath),
        size: info.size
      });
      return;
    }

    if (url.pathname === "/api/compile") {
      json(res, 200, await compileSource(body));
      return;
    }

    if (url.pathname === "/api/save-trace") {
      json(res, 200, await saveTrace(body));
      return;
    }

    if (url.pathname === "/api/process") {
      json(res, 200, await inspectProcess(body));
      return;
    }

    notFound(res);
  } catch (error) {
    json(res, 400, {
      ok: false,
      error: error.message
    });
  }
}

let activePort = basePort;

function handleRequest(req, res) {
  if (req.url?.startsWith("/api/")) {
    routeApi(req, res);
    return;
  }
  serveStatic(req, res);
}

function createAppServer() {
  return createServer(handleRequest);
}

function listen(port, attempts = 0) {
  const server = createAppServer();
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attempts < 20) {
      listen(port + 1, attempts + 1);
      return;
    }
    throw error;
  });

  server.listen(port, bindHost, async () => {
    activePort = port;
    const urls = await buildBrowserUrls(port);
    const displayUrl = urls.advertised || urls.bound;
    console.log(`Under the Hood viewer running at ${displayUrl}`);
    if (bindMode === "tailnet" && bindHost !== "127.0.0.1") {
      listenOnLocalhost(port);
    }
    if (resolvedBind.warning) {
      console.log(resolvedBind.warning);
    }
    if (urls.tailnet) {
      console.log(`Tailnet URL: ${urls.tailnet}`);
    }
    if (urls.funnel) {
      console.log(`Funnel URL: ${urls.funnel}`);
      console.log(`Funnel source: ${urls.funnelSource}`);
    }
    if (bindHost !== "127.0.0.1" || explicitPublicUrl || urls.funnel) {
      console.log(`Agent bind: ${bindHost}`);
      console.log(`Advertise URL: ${urls.advertised || displayUrl}`);
    }
  });
}

function listenOnLocalhost(port) {
  const localhostServer = createAppServer();
  localhostServer.once("error", (error) => {
    console.log(`Localhost URL unavailable: ${error.message}`);
  });
  localhostServer.listen(port, "127.0.0.1", () => {
    console.log(`Local URL: http://127.0.0.1:${port}`);
  });
}

listen(basePort);
