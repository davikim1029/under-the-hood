#!/usr/bin/env node
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const port = Number.parseInt(process.env.PORT || "5173", 10);
const command = process.argv[2] || "menu";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stripIpv6Brackets(hostname) {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
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

function isTailscaleHost(hostname) {
  const host = stripIpv6Brackets(hostname);
  const octets = parseIpv4(host);
  if (octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
    return true;
  }
  return host.startsWith("fd7a:115c:a1e0:");
}

function formatHostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function detectTailscaleAddresses() {
  const tailscale = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry.address || entry.internal || !isTailscaleHost(entry.address)) continue;
      const family = typeof entry.family === "string" ? entry.family : `IPv${entry.family}`;
      tailscale.push({
        interface: name,
        address: entry.address,
        family
      });
    }
  }
  tailscale.sort((a, b) => {
    if (a.family === b.family) return a.address.localeCompare(b.address);
    return a.family === "IPv4" ? -1 : 1;
  });
  return tailscale;
}

function tailnetUrl() {
  const address = detectTailscaleAddresses().find((entry) => entry.family === "IPv4")
    || detectTailscaleAddresses()[0];
  return address ? `http://${formatHostForUrl(address.address)}:${port}` : "";
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function readHealth() {
  const candidates = [
    process.env.UTH_HEALTH_URL,
    `http://127.0.0.1:${port}`,
    tailnetUrl()
  ].filter(Boolean);

  const tried = [];
  for (const baseUrl of candidates) {
    try {
      const health = await fetchJson(`${baseUrl.replace(/\/$/, "")}/api/health`);
      return { baseUrl, health };
    } catch (error) {
      tried.push(`${baseUrl}: ${error.message}`);
    }
  }

  throw new Error(`No running viewer answered health.\n${tried.join("\n")}`);
}

function printHealth(result) {
  const health = result.health;
  const urls = health.browserUrls || {};
  console.log(`healthy: ${health.ok ? "yes" : "no"}`);
  console.log(`checked: ${result.baseUrl}`);
  console.log(`pid: ${health.pid}`);
  console.log(`platform: ${health.platform}/${health.arch}`);
  console.log(`bind: ${health.bindHost} (${health.bindMode})`);
  if (urls.funnel) console.log(`funnel: ${urls.funnel}`);
  if (urls.tailnet) console.log(`tailnet: ${urls.tailnet}`);
  console.log(`advertised: ${urls.advertised || result.baseUrl}`);
}

async function printUrl() {
  try {
    const { health } = await readHealth();
    const urls = health.browserUrls || {};
    console.log(urls.funnel || urls.tailnet || urls.advertised || urls.local || tailnetUrl());
    return;
  } catch {
    const url = tailnetUrl();
    if (!url) {
      throw new Error("No Tailscale interface was detected on this machine.");
    }
    console.log(url);
  }
}

function startServer() {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: __dirname,
    env: {
      ...process.env,
      UTH_BIND: process.env.UTH_BIND || "tailnet"
    },
    stdio: "inherit"
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

async function showMenu() {
  const rl = readline.createInterface({ input, output });
  try {
    console.log("\nUnder the Hood CLI");
    console.log("1. Start server");
    console.log("2. Check health");
    console.log("3. Print Tailscale URL");
    console.log("4. Quit");
    const choice = (await rl.question("\nChoose an option: ")).trim();
    if (choice === "1") startServer();
    else if (choice === "2") printHealth(await readHealth());
    else if (choice === "3") await printUrl();
    else if (choice === "4" || choice === "q") return;
    else throw new Error("Unknown menu option.");
  } finally {
    rl.close();
  }
}

try {
  if (command === "menu") await showMenu();
  else if (command === "start" || command === "server") startServer();
  else if (command === "health") printHealth(await readHealth());
  else if (command === "url" || command === "tailscale-url") await printUrl();
  else {
    console.log("Usage: node cli.mjs [menu|start|health|url]");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
