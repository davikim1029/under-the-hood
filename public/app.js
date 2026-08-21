const compileSample = `#include <stdio.h>

int square(int value) {
  return value * value;
}

int accumulate(int limit) {
  int total = 0;
  for (int index = 0; index < limit; index++) {
    total += square(index);
  }
  return total;
}

int main(void) {
  printf("answer=%d\\n", accumulate(6));
  return 0;
}
`;

const saveSample = `#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  uint32_t version;
  uint32_t score;
  char name[16];
} SaveRecord;

int main(int argc, char **argv) {
  const char *path = argc > 1 ? argv[1] : "save-output.bin";
  SaveRecord record = {1, 4242, "pilot"};
  unsigned char frame[sizeof(record) + 8];

  memcpy(frame, "UTHSAVE\\0", 8);
  memcpy(frame + 8, &record, sizeof(record));

  printf("frame virtual address: %p\\n", (void *)frame);
  printf("record virtual address: %p\\n", (void *)&record);
  printf("path pointer address: %p\\n", (void *)path);

  FILE *file = fopen(path, "wb");
  if (!file) {
    perror("fopen");
    return 1;
  }

  size_t wrote = fwrite(frame, 1, sizeof(frame), file);
  fflush(file);
  fclose(file);

  printf("wrote %zu bytes to %s\\n", wrote, path);
  return wrote == sizeof(frame) ? 0 : 2;
}
`;

const state = {
  root: "",
  currentFileName: "snippet.c",
  currentFilePath: "",
  currentLanguage: "c",
  targets: [
    {
      id: "local",
      name: "Local",
      baseUrl: "",
      kind: "local"
    }
  ],
  activeTargetId: "local",
  compileResult: null,
  artifact: "assembly",
  saveResult: null,
  saveArtifact: "hexDump",
  processResult: null,
  processArtifact: "ps",
  activeMode: "compile",
  folderBrowser: {
    root: "",
    parent: "",
    entries: [],
    places: []
  }
};

const authState = {
  enabled: false,
  authenticated: false,
  requiresUsername: false,
  requiresPassword: false
};
let appStarted = false;
let appStarting = false;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const savedTargetsKey = "under-the-hood.targets";

function resetSavePath() {
  $("#savePath").value = "";
}

function setStatus(message) {
  $("#runtimeStatus").textContent = message;
}

function languageFromPath(filePath) {
  return String(filePath || "").toLowerCase().endsWith(".py") ? "python" : "c";
}

function updateArtifactTabLabels(language = state.currentLanguage) {
  const labels = language === "python"
    ? {
        assembly: "Bytecode",
        disassembly: "VM Ops",
        llvmIr: "AST",
        symbols: "Project/Deps",
        callGraph: "Calls"
      }
    : {
        assembly: "Assembly",
        disassembly: "Machine Code",
        llvmIr: "LLVM IR",
        symbols: "Symbols",
        callGraph: "Calls"
      };

  $$(".artifact-tab").forEach((button) => {
    button.textContent = labels[button.dataset.artifact] || button.textContent;
  });
}

function renderAccessLinks(health = {}) {
  const container = $("#accessLinks");
  const urls = health.browserUrls || {};
  const funnelUrl = urls.funnel || "";
  const tailnetUrl = urls.tailnet || "";
  const advertisedUrl = urls.advertised || "";

  if (funnelUrl) {
    const tailnet = tailnetUrl ? ` <span>Tailnet: <a href="${escapeHtml(tailnetUrl)}">${escapeHtml(tailnetUrl)}</a></span>` : "";
    container.innerHTML = `Funnel: <a href="${escapeHtml(funnelUrl)}">${escapeHtml(funnelUrl)}</a>${tailnet}`;
    return;
  }

  if (tailnetUrl && (health.bindMode === "tailnet" || health.bindMode === "all")) {
    container.innerHTML = `Tailnet: <a href="${escapeHtml(tailnetUrl)}">${escapeHtml(tailnetUrl)}</a>`;
    return;
  }

  if (tailnetUrl) {
    container.innerHTML = `Tailnet detected: restart with <code>npm run tailnet</code> for <a href="${escapeHtml(tailnetUrl)}">${escapeHtml(tailnetUrl)}</a>`;
    return;
  }

  if (health.browserUrls?.funnelMessage) {
    container.textContent = health.browserUrls.funnelMessage;
    return;
  }

  if (advertisedUrl && advertisedUrl !== urls.local) {
    container.innerHTML = `Access: <a href="${escapeHtml(advertisedUrl)}">${escapeHtml(advertisedUrl)}</a>`;
    return;
  }

  container.textContent = health.warning || "Local-only viewer";
}

function activeTarget() {
  return state.targets.find((target) => target.id === state.activeTargetId) || state.targets[0];
}

function targetLabel() {
  const target = activeTarget();
  return target.kind === "local" ? "Local" : target.name;
}

function normalizeUrlForClient(value) {
  const raw = value.trim();
  const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function targetIdFromUrl(baseUrl) {
  return `agent:${baseUrl}`;
}

function targetNameFromUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    return baseUrl;
  }
}

function loadSavedTargets() {
  try {
    const saved = JSON.parse(localStorage.getItem(savedTargetsKey) || "[]");
    for (const target of saved) {
      if (!target?.baseUrl) continue;
      upsertTarget({
        id: targetIdFromUrl(target.baseUrl),
        name: target.name || targetNameFromUrl(target.baseUrl),
        baseUrl: target.baseUrl,
        kind: "agent"
      });
    }
  } catch {
    localStorage.removeItem(savedTargetsKey);
  }
}

function saveTargets() {
  const remoteTargets = state.targets
    .filter((target) => target.kind !== "local")
    .map(({ name, baseUrl }) => ({ name, baseUrl }));
  localStorage.setItem(savedTargetsKey, JSON.stringify(remoteTargets));
}

function upsertTarget(target) {
  const existing = state.targets.findIndex((item) => item.id === target.id);
  if (existing >= 0) {
    state.targets[existing] = { ...state.targets[existing], ...target };
  } else {
    state.targets.push(target);
  }
  return state.targets.find((item) => item.id === target.id);
}

function renderTargets() {
  const select = $("#targetSelect");
  select.innerHTML = "";
  for (const target of state.targets) {
    const option = document.createElement("option");
    option.value = target.id;
    option.textContent = target.kind === "local" ? "Local" : target.name;
    select.append(option);
  }
  select.value = state.activeTargetId;
  $("#targetUrl").value = activeTarget().baseUrl || "";
}

async function requestJson(path, { method = "POST", body = {} } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: method === "POST" ? { "content-type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || payload.error?.message || payload.stderr || "Request failed.");
  }
  return payload;
}

function applyAuthStatus(status = {}) {
  authState.enabled = Boolean(status.enabled);
  authState.authenticated = Boolean(status.authenticated);
  authState.requiresUsername = Boolean(status.requiresUsername);
  authState.requiresPassword = Boolean(status.requiresPassword);

  const usernameField = $("#loginUsernameField");
  const usernameInput = $("#loginUsername");
  const passwordField = $("#loginPasswordField");
  const passwordInput = $("#loginPassword");

  usernameField.hidden = !authState.requiresUsername;
  usernameInput.disabled = !authState.requiresUsername;
  usernameInput.required = authState.requiresUsername;
  passwordField.hidden = !authState.requiresPassword;
  passwordInput.disabled = !authState.requiresPassword;
  passwordInput.required = authState.requiresPassword;
}

function setLoginMessage(message = "") {
  $("#loginMessage").textContent = message;
}

function showLoginGate() {
  document.body.classList.remove("auth-pending", "auth-ready");
  document.body.classList.add("auth-required");
  setLoginMessage("");
  const focusTarget = authState.requiresUsername ? $("#loginUsername") : $("#loginPassword");
  window.requestAnimationFrame(() => focusTarget?.focus());
}

function showViewerShell() {
  document.body.classList.remove("auth-pending", "auth-required");
  document.body.classList.add("auth-ready");
}

async function submitLogin(event) {
  event.preventDefault();
  setLoginMessage("");
  const button = $("#loginButton");
  button.disabled = true;
  try {
    const status = await requestJson("/api/auth/login", {
      body: {
        username: $("#loginUsername").value,
        password: $("#loginPassword").value
      }
    });
    applyAuthStatus(status);
    await startViewer();
  } catch (error) {
    if (authState.authenticated) {
      showViewerShell();
      showError(error);
    } else {
      setLoginMessage(error.message || "Sign in failed.");
      $("#loginPassword").value = "";
    }
  } finally {
    button.disabled = false;
  }
}

async function api(path, body = {}, options = {}) {
  const target = activeTarget();
  const method = options.method || "POST";
  if (options.local || target.kind === "local") {
    return requestJson(path, { method, body });
  }

  return requestJson("/api/agent/proxy", {
    method: "POST",
    body: {
      baseUrl: target.baseUrl,
      apiPath: path,
      method,
      payload: body
    }
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function discoverTargets() {
  setStatus("Looking for Tailnet peers...");
  const result = await api("/api/tailscale/status", {}, { local: true });
  if (!result.available) {
    setStatus(result.message || "Tailscale discovery is not available here");
    return;
  }

  for (const peer of result.peers || []) {
    if (!peer.baseUrl) continue;
    upsertTarget({
      id: targetIdFromUrl(peer.baseUrl),
      name: `${peer.name}${peer.online ? "" : " offline"}`,
      baseUrl: peer.baseUrl,
      kind: "agent",
      online: peer.online,
      os: peer.os
    });
  }
  saveTargets();
  renderTargets();
  setStatus(result.message || "Tailnet peers discovered");
}

async function connectTarget() {
  const manualUrl = $("#targetUrl").value.trim();
  if (manualUrl) {
    const baseUrl = normalizeUrlForClient(manualUrl);
    const target = upsertTarget({
      id: targetIdFromUrl(baseUrl),
      name: targetNameFromUrl(baseUrl),
      baseUrl,
      kind: "agent"
    });
    state.activeTargetId = target.id;
    saveTargets();
    renderTargets();
  }

  setStatus(`Connecting to ${targetLabel()}...`);
  const health = await api("/api/health", {}, { method: "GET" });
  if (!health.ok) {
    throw new Error(health.error || "Target did not return a healthy probe response.");
  }

  state.root = health.root;
  $("#folderPath").value = health.root;
  $("#pidInput").value = health.pid;
  resetSavePath();
  state.currentFileName = "snippet.c";
  state.currentFilePath = "";
  state.currentLanguage = "c";
  $("#currentFileName").textContent = "snippet.c";
  state.compileResult = null;
  state.saveResult = null;
  state.processResult = null;
  updateFunctionSelect([]);
  updateArtifactTabLabels();
  renderStages([]);
  renderSaveLayers([]);
  renderArtifact();
  renderSaveOutput();
  renderProcessOutput();
  renderTargets();
  renderAccessLinks(health);
  setStatus(`${targetLabel()} · ${health.platform}/${health.arch} · PID ${health.pid}`);
  await scanFiles();
}

function renderFiles(files = []) {
  const list = $("#fileList");
  list.innerHTML = "";
  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "stage-item";
    empty.innerHTML = "<strong>No source files found</strong><span class='stage-meta'>Paste code or load the sample.</span>";
    list.append(empty);
    return;
  }

  for (const file of files) {
    const button = document.createElement("button");
    button.className = "file-item";
    button.type = "button";
    button.dataset.path = file.path;
    button.innerHTML = `<strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.rel)} · ${formatBytes(file.size)}</small>`;
    button.addEventListener("click", () => loadFile(file.path, button));
    list.append(button);
  }
}

function showFolderDialog() {
  const dialog = $("#folderDialog");
  if (typeof dialog.showModal === "function" && !dialog.open) {
    dialog.showModal();
    return;
  }
  dialog.setAttribute("open", "");
}

function closeFolderDialog() {
  const dialog = $("#folderDialog");
  if (typeof dialog.close === "function" && dialog.open) {
    dialog.close();
    return;
  }
  dialog.removeAttribute("open");
}

async function openFolderBrowser() {
  showFolderDialog();
  await browseFolders($("#folderPath").value || state.root);
}

async function browseFolders(folderPath) {
  setStatus(`Browsing ${targetLabel()} folders...`);
  const result = await api("/api/browse-folders", { path: folderPath || state.root });
  state.folderBrowser = {
    root: result.root,
    parent: result.parent || "",
    entries: result.entries || [],
    places: result.places || []
  };
  renderFolderBrowser(result);
  setStatus(`${targetLabel()} · folder browser ready`);
}

function renderFolderBrowser(result) {
  $("#folderBrowserTarget").textContent = targetLabel();
  $("#folderBrowserPath").value = result.root;
  $("#folderUp").disabled = !result.parent;

  const places = $("#folderPlaces");
  places.innerHTML = "";
  for (const place of result.places || []) {
    const button = document.createElement("button");
    button.className = "folder-place";
    button.type = "button";
    button.textContent = place.name;
    button.classList.toggle("active", place.path === result.root);
    button.addEventListener("click", () => browseFolders(place.path).catch(showError));
    places.append(button);
  }

  const entries = $("#folderEntries");
  entries.innerHTML = "";
  if (!result.entries?.length) {
    const empty = document.createElement("div");
    empty.className = "folder-empty";
    empty.textContent = "No folders";
    entries.append(empty);
    return;
  }

  for (const folder of result.entries) {
    const button = document.createElement("button");
    const name = document.createElement("strong");
    const detail = document.createElement("small");
    button.className = "folder-entry";
    button.type = "button";
    name.textContent = folder.symlink ? `${folder.name} ->` : folder.name;
    detail.textContent = folder.path;
    button.append(name, detail);
    button.addEventListener("click", () => browseFolders(folder.path).catch(showError));
    entries.append(button);
  }
}

async function selectBrowsedFolder() {
  const chosen = state.folderBrowser.root || $("#folderBrowserPath").value;
  if (!chosen) return;
  $("#folderPath").value = chosen;
  state.root = chosen;
  closeFolderDialog();
  await scanFiles();
}

async function scanFiles() {
  setStatus(`Scanning ${targetLabel()} source folder...`);
  const root = $("#folderPath").value;
  const result = await api("/api/list-files", { root });
  state.root = result.root;
  $("#folderPath").value = result.root;
  renderFiles(result.files);
  setStatus(`${targetLabel()} · ${result.files.length} source files ready`);
}

async function loadFile(filePath, button) {
  setStatus(`Loading source file from ${targetLabel()}...`);
  const result = await api("/api/read-file", { path: filePath });
  $("#sourceEditor").value = result.source;
  state.currentFileName = result.name;
  state.currentFilePath = result.path;
  state.currentLanguage = languageFromPath(result.path);
  $("#currentFileName").textContent = result.name;
  $$(".file-item").forEach((item) => item.classList.remove("active"));
  button?.classList.add("active");
  updateFunctionSelect([]);
  updateArtifactTabLabels();
  drawPipeline([]);
  setStatus(`${targetLabel()} · ${result.name} loaded`);
}

function updateFunctionSelect(functions = []) {
  const select = $("#functionSelect");
  const previous = select.value;
  select.innerHTML = '<option value="">All functions</option>';
  for (const fn of functions) {
    const option = document.createElement("option");
    option.value = fn.name;
    option.textContent = fn.name;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  }
}

async function compile() {
  setStatus(`Compiling on ${targetLabel()}...`);
  drawPipeline([]);
  const result = await api("/api/compile", {
    source: $("#sourceEditor").value,
    fileName: state.currentFileName,
    sourcePath: state.currentFilePath,
    root: state.root,
    language: state.currentLanguage,
    optimize: $("#optimization").value,
    functionName: $("#functionSelect").value
  });
  state.compileResult = result;
  state.currentLanguage = result.language || state.currentLanguage;
  updateArtifactTabLabels(state.currentLanguage);
  if (result.source?.functions) updateFunctionSelect(result.source.functions);
  $("#sourceHash").textContent = result.sourceHash ? `sha ${result.sourceHash}` : "";
  renderStages(result.stages || []);
  drawPipeline(result.stages || []);
  renderArtifact();
  setStatus(result.ok ? `${targetLabel()} · compile artifacts ready` : `${targetLabel()} · compiler stopped`);
}

function renderStages(stages) {
  const list = $("#stageList");
  list.innerHTML = "";
  if (!stages.length) {
    list.innerHTML = "<div class='stage-item'><strong>Waiting for compile</strong><span class='stage-meta'>Run a compile to populate each stage.</span></div>";
    return;
  }

  for (const stage of stages) {
    const item = document.createElement("div");
    item.className = "stage-item";
    const status = stage.ok ? "ok" : "bad";
    item.innerHTML = `
      <strong class="${status}">${stage.label}</strong>
      <span class="stage-meta">${stage.ok ? "completed" : "stopped"} · ${stage.durationMs} ms</span>
      ${stage.stderr ? `<span class="stage-meta">${escapeHtml(stage.stderr.slice(0, 180))}</span>` : ""}
    `;
    list.append(item);
  }
}

function drawPipeline(stages) {
  const canvas = $("#pipelineCanvas");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const isPython = state.currentLanguage === "python" || state.compileResult?.language === "python";
  const labels = isPython
    ? ["Source", "Project", "AST", "Code Obj", "Bytecode", "Imports", "Deps"]
    : ["Source", "Preprocess", "LLVM IR", "Assembly", "Object", "Link", "Machine"];
  const stageKeys = isPython
    ? ["source", "project", "ast", "compile", "bytecode", "imports", "dependencies"]
    : ["source", "preprocess", "llvm", "assembly", "object", "link", "disassemble"];
  const colors = ["#17211f", "#14746f", "#8cae33", "#c44e2e", "#48506b", "#0c5652", "#111716"];
  const margin = 22;
  const width = Math.max(96, (rect.width - margin * 2) / labels.length - 10);
  const y = 74;
  const stageMap = new Map((stages || []).map((stage) => [stage.id, stage]));

  ctx.lineWidth = 2;
  ctx.strokeStyle = "#cfd8d2";
  for (let index = 0; index < labels.length - 1; index += 1) {
    const x1 = margin + index * (width + 10) + width;
    const x2 = margin + (index + 1) * (width + 10);
    ctx.beginPath();
    ctx.moveTo(x1, y + 28);
    ctx.lineTo(x2, y + 28);
    ctx.stroke();
  }

  labels.forEach((label, index) => {
    const x = margin + index * (width + 10);
    const key = stageKeys[index];
    const stage = stageMap.get(key);
    ctx.fillStyle = colors[index];
    ctx.beginPath();
    roundRect(ctx, x, y, width, 56, 8);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 12px system-ui";
    ctx.fillText(label, x + 10, y + 23);
    ctx.font = "11px system-ui";
    const status = index === 0 ? "editor" : stage ? (stage.ok ? `${stage.durationMs} ms` : "stopped") : "pending";
    ctx.fillText(status, x + 10, y + 41);
  });

  ctx.fillStyle = "#66706d";
  ctx.font = "12px system-ui";
  ctx.fillText(
    isPython
      ? "Python artifacts are CPython bytecode and interpreter-level operations, with uv project context when available."
      : "Real local artifacts. Runtime addresses are assigned later by the loader.",
    margin,
    168
  );
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
}

function renderArtifact() {
  const output = $("#artifactOutput");
  const result = state.compileResult;
  if (!result) {
    output.textContent = "Compile a C file to inspect lower-level artifacts.";
    return;
  }

  if (!result.ok) {
    output.textContent = (result.stages || [])
      .map((stage) => `${stage.label}\n${stage.stderr || stage.stdout || "No output."}`)
      .join("\n\n");
    return;
  }

  const artifacts = result.artifacts || {};
  const selectedFunction = $("#functionSelect").value;
  const isPython = result.language === "python";

  if (state.artifact === "assembly") {
    output.textContent =
      isPython
        ? artifacts.bytecode || artifacts.assembly || "No bytecode emitted."
        : selectedFunction && artifacts.assemblyFiltered
        ? artifacts.assemblyFiltered
        : artifacts.assembly || "No assembly emitted.";
    return;
  }

  if (state.artifact === "disassembly") {
    if (artifacts.instructionRows?.length) {
      const rows = selectedFunction
        ? artifacts.instructionRows.filter((row) => row.function === selectedFunction)
        : artifacts.instructionRows;
      const table = rows
        .map((row) => `${row.address.padStart(8, "0")}  ${row.bytes.padEnd(28)}  ${row.instruction}`)
        .join("\n");
      output.textContent =
        table ||
        artifacts.disassemblyFiltered ||
        artifacts.disassembly ||
        "No disassembly emitted for this function.";
    } else {
      output.textContent =
        selectedFunction && artifacts.disassemblyFiltered
          ? artifacts.disassemblyFiltered
          : artifacts.disassembly || "No disassembly emitted.";
    }
    return;
  }

  if (state.artifact === "llvmIr") {
    output.textContent = artifacts.llvmIr || (isPython ? "No AST emitted." : "No LLVM IR emitted.");
    return;
  }

  if (state.artifact === "symbols") {
    if (isPython) {
      output.textContent = artifacts.symbols || "No project or dependency output.";
      return;
    }
    output.textContent = [
      `Object: ${formatBytes(artifacts.objectBytes)}`,
      `Executable: ${formatBytes(artifacts.executableBytes)}`,
      "",
      artifacts.symbols || "No symbols emitted."
    ].join("\n");
    return;
  }

  if (state.artifact === "callGraph") {
    const calls = result.source?.callGraph || [];
    output.textContent =
      calls.map((entry) => `${entry.from} -> ${entry.to.length ? entry.to.join(", ") : "(no local calls)"}`).join("\n") ||
      "No C function definitions detected.";
  }
}

async function runSaveTrace() {
  setStatus(`Running save probe on ${targetLabel()}...`);
  const result = await api("/api/save-trace", {
    source: $("#saveEditor").value,
    optimize: $("#saveOptimization").value,
    savePath: $("#savePath").value,
    useSyscallTrace: $("#attemptSyscallTrace").checked
  });
  state.saveResult = result;
  renderSaveLayers(result.layers || []);
  renderSaveOutput();
  setStatus(result.ok ? `${targetLabel()} · save bytes inspected` : `${targetLabel()} · save probe stopped`);
}

function renderSaveLayers(layers) {
  const list = $("#saveLayers");
  list.innerHTML = "";
  if (!layers.length) {
    list.innerHTML = "<div class='layer-item'><strong>Waiting for save run</strong><p>Run the save probe to see memory, runtime, filesystem, and byte-offset evidence.</p></div>";
    return;
  }

  for (const layer of layers) {
    const item = document.createElement("div");
    item.className = "layer-item";
    item.innerHTML = `<strong>${escapeHtml(layer.name)}</strong><p>${escapeHtml(layer.evidence)}</p>`;
    list.append(item);
  }
}

function renderSaveOutput() {
  const output = $("#saveOutput");
  const result = state.saveResult;
  if (!result) {
    output.textContent = "Run the save probe to inspect file offsets and bytes.";
    return;
  }

  if (!result.ok && result.phase === "compile") {
    output.textContent =
      [result.compile?.stderr, result.compile?.stdout].filter(Boolean).join("\n") ||
      "The save probe did not compile.";
    return;
  }

  if (state.saveArtifact === "stdout") {
    output.textContent = [
      result.run?.stdout || "",
      result.run?.stderr ? `\nstderr:\n${result.run.stderr}` : ""
    ].join("").trim() || "No program output.";
    return;
  }

  if (state.saveArtifact === "syscalls") {
    if (!result.syscallTrace) {
      output.textContent = "Syscall tracing was not requested. Linux uses strace; macOS uses dtruss, which often needs elevated permissions and may be blocked for protected processes.";
      return;
    }
    output.textContent =
      [result.syscallTrace.stdout, result.syscallTrace.stderr].filter(Boolean).join("\n") ||
      "No syscall output returned.";
    return;
  }

  const meta = result.file
    ? [
        `path: ${result.file.path}`,
        `size: ${result.file.size} bytes`,
        `mode: ${result.file.mode}`,
        `mtime: ${result.file.mtime}`,
        `blocks: ${result.file.blocks ?? "unknown"}`,
        ""
      ].join("\n")
    : `file read error: ${result.readError}\n\n`;
  const dump = (result.hexDump || [])
    .map((row) => `${row.offset.toString(16).padStart(8, "0")}  ${row.hex.padEnd(48)}  ${row.ascii}`)
    .join("\n");
  output.textContent = `${meta}${dump || "No bytes to display."}`;
}

async function inspectPid() {
  setStatus(`Inspecting PID on ${targetLabel()}...`);
  const result = await api("/api/process", { pid: $("#pidInput").value });
  state.processResult = result;
  renderProcessSummary(result);
  renderProcessOutput();
  setStatus(result.ok ? `${targetLabel()} · PID ${result.pid} inspected` : `${targetLabel()} · PID inspection returned partial output`);
}

function renderProcessSummary(result) {
  const list = $("#processSummary");
  list.innerHTML = "";
  const mapSource = result.vmmap?.source;
  if (mapSource) {
    const item = document.createElement("div");
    item.className = "stage-item";
    item.innerHTML = `<strong>Memory map source</strong><span class="stage-meta">${escapeHtml(mapSource)}</span>`;
    list.append(item);
  }

  const notes = result.notes || [];
  for (const note of notes) {
    const item = document.createElement("div");
    item.className = "stage-item";
    item.innerHTML = `<strong>Process note</strong><span class="stage-meta">${escapeHtml(note)}</span>`;
    list.append(item);
  }

  const histogram = $("#vmmapHistogram");
  histogram.innerHTML = "";
  const rows = result.vmmap?.parsed?.histogram || [];
  const max = Math.max(1, ...rows.map((row) => row.count));
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "histogram-row";
    item.innerHTML = `
      <span>${escapeHtml(row.region)}</span>
      <div>
        <div class="bar" style="width:${Math.max(8, (row.count / max) * 100)}%"></div>
        <small>${row.count}</small>
      </div>
    `;
    histogram.append(item);
  }
}

function renderProcessOutput() {
  const output = $("#processOutput");
  const result = state.processResult;
  if (!result) {
    output.textContent = "Enter a PID to inspect process metadata and memory-map output.";
    return;
  }

  if (state.processArtifact === "ps") {
    output.textContent = [result.ps?.stdout, result.ps?.stderr].filter(Boolean).join("\n") || "No process output.";
    return;
  }

  if (state.processArtifact === "vmmap") {
    output.textContent = [result.vmmap?.stdout, result.vmmap?.stderr].filter(Boolean).join("\n") || "No memory-map output.";
    return;
  }

  output.textContent = [result.lsof?.stdout, result.lsof?.stderr].filter(Boolean).join("\n") || "No open-file output.";
}

function switchMode(mode) {
  state.activeMode = mode;
  $$(".mode-button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  $$("[data-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.panel !== mode));
  if (mode === "compile") drawPipeline(state.compileResult?.stages || []);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function wireEvents() {
  $("#loginForm").addEventListener("submit", (event) => submitLogin(event).catch(showLoginError));
  $("#discoverTargets").addEventListener("click", () => discoverTargets().catch(showError));
  $("#connectTarget").addEventListener("click", () => connectTarget().catch(showError));
  $("#targetSelect").addEventListener("change", () => {
    state.activeTargetId = $("#targetSelect").value;
    renderTargets();
    connectTarget().catch(showError);
  });

  $("#browseFolder").addEventListener("click", () => openFolderBrowser().catch(showError));
  $("#closeFolderDialog").addEventListener("click", closeFolderDialog);
  $("#folderUp").addEventListener("click", () => {
    if (state.folderBrowser.parent) browseFolders(state.folderBrowser.parent).catch(showError);
  });
  $("#folderGo").addEventListener("click", () => browseFolders($("#folderBrowserPath").value).catch(showError));
  $("#folderBrowserPath").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    browseFolders($("#folderBrowserPath").value).catch(showError);
  });
  $("#selectFolder").addEventListener("click", () => selectBrowsedFolder().catch(showError));
  $("#scanFiles").addEventListener("click", () => scanFiles().catch(showError));
  $("#loadSample").addEventListener("click", () => {
    state.currentFileName = "snippet.c";
    state.currentFilePath = "";
    state.currentLanguage = "c";
    $("#currentFileName").textContent = "snippet.c";
    $("#sourceEditor").value = compileSample;
    updateFunctionSelect([]);
    updateArtifactTabLabels();
    drawPipeline([]);
    setStatus("Sample source loaded");
  });
  $("#compileButton").addEventListener("click", () => compile().catch(showError));
  $("#functionSelect").addEventListener("change", () => compile().catch(showError));
  $("#optimization").addEventListener("change", () => compile().catch(showError));
  $$(".artifact-tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.artifact = button.dataset.artifact;
      $$(".artifact-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
      renderArtifact();
    });
  });

  $("#saveSample").addEventListener("click", () => {
    $("#saveEditor").value = saveSample;
    setStatus("Save sample loaded");
  });
  $("#runSaveTrace").addEventListener("click", () => runSaveTrace().catch(showError));
  $$(".save-tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.saveArtifact = button.dataset.save;
      $$(".save-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
      renderSaveOutput();
    });
  });

  $("#inspectPid").addEventListener("click", () => inspectPid().catch(showError));
  $$(".process-tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.processArtifact = button.dataset.process;
      $$(".process-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
      renderProcessOutput();
    });
  });

  $$(".mode-button").forEach((button) => {
    button.addEventListener("click", () => switchMode(button.dataset.mode));
  });

  window.addEventListener("resize", () => {
    if (state.activeMode === "compile") drawPipeline(state.compileResult?.stages || []);
  });
}

function showError(error) {
  console.error(error);
  setStatus(error.message);
}

function showLoginError(error) {
  console.error(error);
  setLoginMessage(error.message || "Sign in failed.");
}

async function startViewer() {
  if (appStarted || appStarting) return;
  appStarting = true;
  showViewerShell();
  try {
    loadSavedTargets();
    renderTargets();
    $("#sourceEditor").value = compileSample;
    $("#saveEditor").value = saveSample;
    renderStages([]);
    renderSaveLayers([]);
    renderArtifact();
    renderSaveOutput();
    renderProcessOutput();
    updateArtifactTabLabels();
    drawPipeline([]);

    const health = await requestJson("/api/health", { method: "GET" });
    state.root = health.root;
    $("#folderPath").value = health.root;
    $("#pidInput").value = health.pid;
    resetSavePath();
    renderAccessLinks(health);
    setStatus(`Local · ${health.platform}/${health.arch} · PID ${health.pid}`);
    await scanFiles();
    appStarted = true;
  } finally {
    appStarting = false;
  }
}

async function boot() {
  wireEvents();
  try {
    const status = await requestJson("/api/auth/status", { method: "GET" });
    applyAuthStatus(status);
    if (authState.enabled && !authState.authenticated) {
      showLoginGate();
      return;
    }
    await startViewer();
  } catch (error) {
    document.body.classList.remove("auth-pending");
    showError(error);
  }
}

boot();
