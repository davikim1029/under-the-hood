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
  compileResult: null,
  artifact: "assembly",
  saveResult: null,
  saveArtifact: "hexDump",
  processResult: null,
  processArtifact: "ps",
  activeMode: "compile",
  pipelineHitRegions: [],
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

const pipelineModels = {
  c: [
    { key: "source", label: "Source", color: "#17211f" },
    { key: "preprocess", label: "Preprocess", color: "#14746f" },
    { key: "llvm", label: "LLVM IR", color: "#8cae33" },
    { key: "assembly", label: "Assembly", color: "#c44e2e" },
    { key: "object", label: "Object", color: "#48506b" },
    { key: "link", label: "Link", color: "#0c5652" },
    { key: "disassemble", label: "Machine", color: "#111716" }
  ],
  python: [
    { key: "source", label: "Source", color: "#17211f" },
    { key: "project", label: "Project", color: "#14746f" },
    { key: "ast", label: "AST", color: "#8cae33" },
    { key: "compile", label: "Code Obj", color: "#c44e2e" },
    { key: "bytecode", label: "Bytecode", color: "#48506b" },
    { key: "imports", label: "Imports", color: "#0c5652" },
    { key: "dependencies", label: "Deps", color: "#111716" }
  ]
};

const stageCatalog = {
  c: {
    source: {
      title: "Source",
      kicker: "Human-readable C text before the toolchain transforms it.",
      sections: [
        ["What it is", "This is the program as written: names, functions, types, expressions, comments, and preprocessor directives. It is easy for humans to read, but the CPU cannot execute this text directly."],
        ["Role in compilation", "The compiler reads the source file, tokenizes it, checks grammar and types, and uses it as the starting point for every lower-level artifact shown in this viewer."],
        ["How it affects running code", "Names like total or square do not usually survive as runtime objects. They guide the compiler as it chooses registers, stack slots, control flow, and machine instructions."]
      ]
    },
    preprocess: {
      title: "Preprocess",
      kicker: "Header includes, macros, and conditional compilation expanded into one C translation unit.",
      sections: [
        ["What it is", "The preprocessor handles lines such as #include and #define before the main compiler frontend analyzes the C language itself."],
        ["Role in compilation", "It substitutes macros, chooses #if branches, and pulls in declarations from headers so the compiler sees the complete text for this translation unit."],
        ["How it affects running code", "Preprocessing does not run at program runtime, but it decides which declarations, constants, and macro-expanded expressions the compiler later turns into executable behavior."]
      ]
    },
    llvm: {
      title: "LLVM IR",
      kicker: "A typed intermediate representation used for analysis and optimization.",
      sections: [
        ["What it is", "LLVM IR is lower than C but higher than a specific CPU instruction set. It has explicit operations, branches, loads, stores, and typed values."],
        ["Role in compilation", "Clang lowers C into IR so LLVM passes can optimize control flow, remove dead work, inline functions, and reason about memory before choosing final target instructions."],
        ["How it affects running code", "IR values often become registers, stack slots, constants, or folded-away computations. The final CPU never executes LLVM IR here; it executes target machine code selected from it."]
      ]
    },
    assembly: {
      title: "Assembly",
      kicker: "Human-readable target instructions before they are encoded as object bytes.",
      sections: [
        ["What it is", "Assembly names instructions, registers, labels, and addressing modes for the current CPU architecture."],
        ["Role in compilation", "The backend selects target instructions and emits assembly text so you can inspect the shape of the generated code before it is assembled."],
        ["How it affects running code", "Each assembly instruction corresponds to one or more encoded instruction bytes in the object file. Those bytes are what the CPU frontend eventually fetches and decodes."]
      ]
    },
    object: {
      title: "Object File",
      kicker: "Relocatable machine code plus symbols and relocation records.",
      sections: [
        ["What it is", "An object file contains encoded instructions and data, but it is not usually a complete program yet. It may still refer to symbols defined somewhere else."],
        ["Role in compilation", "The assembler packages machine-code bytes, sections, debug data, symbol tables, and relocation entries into a .o-style artifact."],
        ["How it affects running code", "Object-code offsets are not final virtual addresses. The linker and loader still need to place sections and fix references before execution starts."]
      ]
    },
    link: {
      title: "Link",
      kicker: "Object files and libraries combined into an executable image.",
      sections: [
        ["What it is", "Linking resolves references between object files and libraries, lays out sections, and emits an executable format such as Mach-O or ELF."],
        ["Role in compilation", "The linker decides where code and data sections live relative to one another and records any dynamic-library work the OS loader must finish later."],
        ["How it affects running code", "When you launch the program, the OS loader maps the executable into a process, maps needed libraries, prepares the stack and entry point, then transfers control into the code."]
      ]
    },
    disassemble: {
      title: "Machine / Binary",
      kicker: "Executable instruction bytes viewed as decoded CPU instructions.",
      sections: [
        ["What it is", "The binary contains bytes that encode instructions and data. A disassembler reads those bytes and prints the instruction names, operands, and offsets they represent."],
        ["How it starts running", "The OS does not stream the whole file straight into the CPU. It maps executable pages into the process's virtual address space, and the CPU's instruction pointer points at the next instruction address."],
        ["Inside the CPU", "The CPU fetches instruction bytes through memory and cache, decodes opcodes into internal control signals or micro-ops, reads operands from registers or memory, executes them, and retires results in program order."],
        ["Where results go next", "Results land in architectural registers, flags, vector registers, or memory addresses. Later instructions know where to read because their operands name those registers or addresses; modern CPUs also use register renaming, forwarding, and dependency tracking so nearby instructions can use fresh results without waiting for every slower layer."],
        ["About pins and buffers", "External CPU pins carry power, clocks, interrupts, and bus signals; individual program instructions are not sent as separate pin activations. Inside the chip, transistor networks, queues, caches, execution units, and reorder buffers carry the work between fetch, decode, execute, and commit."]
      ]
    },
    symbols: {
      title: "Symbols",
      kicker: "Names and addresses that help connect source-level ideas to binary sections.",
      sections: [
        ["What it is", "Symbols record names for functions, globals, sections, or debug entries that tools can use to label raw addresses and offsets."],
        ["Role in compilation", "The assembler and linker use symbols to resolve references. Debuggers, profilers, and disassemblers use them to make binary output readable."],
        ["How it affects running code", "The CPU does not need symbol names to execute instructions, but tooling uses them to explain which function or object a runtime address belongs to."]
      ]
    }
  },
  python: {
    source: {
      title: "Python Source",
      kicker: "Human-readable Python code before CPython parses it.",
      sections: [
        ["What it is", "This is the .py text: imports, functions, classes, statements, expressions, and names."],
        ["Role in compilation", "CPython parses the text into an AST, validates syntax, and compiles it into code objects containing bytecode for the Python virtual machine."],
        ["How it affects running code", "The source guides the interpreter's bytecode and name lookups. The CPU runs the CPython interpreter binary, while that interpreter dispatches your Python bytecode."]
      ]
    },
    project: {
      title: "Project Context",
      kicker: "The nearest Python project root and runtime context.",
      sections: [
        ["What it is", "The viewer looks for a nearby pyproject.toml or uv.lock so analysis can run from the same project shape as the selected file."],
        ["Role in compilation", "Project context decides import paths, dependency information, and whether uv can provide the Python runner for inspection."],
        ["How it affects running code", "Python execution depends heavily on sys.path, installed packages, and the active environment. The same file can behave differently in a different project context."]
      ]
    },
    ast: {
      title: "AST",
      kicker: "A tree representation of Python syntax.",
      sections: [
        ["What it is", "The abstract syntax tree represents statements and expressions as structured nodes instead of raw text."],
        ["Role in compilation", "CPython builds the AST first, then compiles that structure into code objects and bytecode."],
        ["How it affects running code", "The AST itself is not executed by the CPU. It determines the bytecode operations that the interpreter will dispatch later."]
      ]
    },
    compile: {
      title: "Code Object",
      kicker: "Compiled Python metadata and bytecode containers.",
      sections: [
        ["What it is", "A code object stores bytecode, constants, names, variable slots, line information, and flags for a module, function, or nested scope."],
        ["Role in compilation", "The compile step turns AST nodes into code objects. Function definitions create nested code objects that are wrapped in function objects at runtime."],
        ["How it affects running code", "When Python calls a function, CPython creates a frame for its code object and interprets that object's bytecode instructions."]
      ]
    },
    bytecode: {
      title: "Bytecode",
      kicker: "Instructions for the CPython virtual machine rather than native machine code.",
      sections: [
        ["What it is", "Python bytecode is a compact instruction stream with operations such as loading constants, calling functions, branching, and returning values."],
        ["Role in compilation", "CPython emits bytecode from code objects so the interpreter can execute a stable VM-level instruction set."],
        ["How it affects running code", "The CPU executes the CPython interpreter's native machine code. That interpreter fetches bytecode instructions, performs the requested operation in C, updates Python frames and objects, then advances to the next bytecode."]
      ]
    },
    imports: {
      title: "Imports",
      kicker: "Module dependencies discovered from source syntax.",
      sections: [
        ["What it is", "Imports name other modules or packages that this file expects to load."],
        ["Role in compilation", "The analyzer extracts imports from the AST without importing the module, so it can show dependency intent without running import-time code."],
        ["How it affects running code", "At runtime, Python resolves imports through sys.path, caches modules in sys.modules, and executes module top-level code the first time a module is loaded."]
      ]
    },
    dependencies: {
      title: "Dependencies",
      kicker: "Installed package context when uv project metadata is available.",
      sections: [
        ["What it is", "The dependency view summarizes nearby package relationships rather than machine instructions."],
        ["Role in compilation", "Dependencies do not change Python bytecode directly unless imported code or environment-specific modules change what the program references."],
        ["How it affects running code", "Runtime behavior can hinge on package versions, native extensions, and import resolution. Native extensions eventually run machine code inside the Python process."]
      ]
    }
  }
};

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

function targetLabel() {
  return "Local";
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
  const method = options.method || "POST";
  return requestJson(path, { method, body });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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

function pipelineLanguage() {
  return state.currentLanguage === "python" || state.compileResult?.language === "python" ? "python" : "c";
}

function getPipelineModel(language = pipelineLanguage()) {
  return pipelineModels[language] || pipelineModels.c;
}

function normalizeStageInfoKey(stageId = "") {
  const normalized = String(stageId);
  if (normalized === "disassemble-otool") return "disassemble";
  return normalized;
}

function stageInfoFor(stageKey, language = pipelineLanguage()) {
  const key = normalizeStageInfoKey(stageKey);
  return stageCatalog[language]?.[key] || stageCatalog.c[key] || {
    title: key || "Stage",
    kicker: "Toolchain stage",
    sections: [
      ["What it is", "This stage is part of the local inspection pipeline."],
      ["Role in compilation", "The viewer records the command output so you can inspect where the pipeline succeeded or stopped."],
      ["How it affects running code", "Successful stages produce artifacts used by later tooling or by the runtime loader."]
    ]
  };
}

function currentStageFor(stageKey) {
  const key = normalizeStageInfoKey(stageKey);
  return (state.compileResult?.stages || []).find((stage) => normalizeStageInfoKey(stage.id) === key);
}

function stageColorFor(stageKey) {
  const key = normalizeStageInfoKey(stageKey);
  return getPipelineModel().find((stage) => stage.key === key)?.color || "#14746f";
}

function openStageDialog(stageKey) {
  const dialog = $("#stageDialog");
  const info = stageInfoFor(stageKey);
  const stage = currentStageFor(stageKey);
  const normalizedKey = normalizeStageInfoKey(stageKey);
  $("#stageDialogTitle").textContent = info.title;
  $("#stageDialogKicker").textContent = info.kicker;
  $("#stageDialogStatus").style.borderLeftColor = stageColorFor(normalizedKey);

  const statusLines = [];
  if (normalizedKey === "source") {
    statusLines.push(escapeHtml(`Current editor buffer: ${state.currentFileName || "snippet.c"}`));
    if (state.currentFilePath) statusLines.push(escapeHtml(state.currentFilePath));
  } else if (stage) {
    statusLines.push(escapeHtml(`${stage.ok ? "Completed" : "Stopped"} in ${stage.durationMs} ms`));
    if (stage.command) statusLines.push(`<code>${escapeHtml(stage.command)}</code>`);
    if (stage.stderr) statusLines.push(escapeHtml(stage.stderr.slice(0, 240)));
  } else {
    statusLines.push("Run a compile to see the concrete command and timing for this stage.");
  }
  $("#stageDialogStatus").innerHTML = statusLines.map((line) => `<span>${line}</span>`).join("");

  $("#stageDialogContent").innerHTML = info.sections
    .map(([heading, body]) => `
      <section class="stage-dialog-section">
        <h3>${escapeHtml(heading)}</h3>
        <p>${escapeHtml(body)}</p>
      </section>
    `)
    .join("");

  if (typeof dialog.showModal === "function" && !dialog.open) {
    dialog.showModal();
    return;
  }
  dialog.setAttribute("open", "");
}

function closeStageDialog() {
  const dialog = $("#stageDialog");
  if (typeof dialog.close === "function" && dialog.open) {
    dialog.close();
    return;
  }
  dialog.removeAttribute("open");
}

function pipelineRegionAtEvent(event) {
  const rect = $("#pipelineCanvas").getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return state.pipelineHitRegions.find((region) =>
    x >= region.x &&
    x <= region.x + region.width &&
    y >= region.y &&
    y <= region.y + region.height
  );
}

function handlePipelineClick(event) {
  const region = pipelineRegionAtEvent(event);
  if (region) openStageDialog(region.key);
}

function updatePipelineCursor(event) {
  $("#pipelineCanvas").style.cursor = pipelineRegionAtEvent(event) ? "pointer" : "default";
}

function renderStages(stages) {
  const list = $("#stageList");
  list.innerHTML = "";
  if (!stages.length) {
    list.innerHTML = "<div class='stage-item'><strong>Waiting for compile</strong><span class='stage-meta'>Run a compile to populate each stage.</span></div>";
    return;
  }

  for (const stage of stages) {
    const item = document.createElement("button");
    const key = normalizeStageInfoKey(stage.id);
    item.className = "stage-item stage-action";
    item.type = "button";
    item.style.setProperty("--stage-color", stageColorFor(key));
    const status = stage.ok ? "ok" : "bad";
    item.innerHTML = `
      <strong class="${status}">${escapeHtml(stage.label)}</strong>
      <span class="stage-meta">${stage.ok ? "completed" : "stopped"} · ${stage.durationMs} ms</span>
      ${stage.stderr ? `<span class="stage-meta">${escapeHtml(stage.stderr.slice(0, 180))}</span>` : ""}
    `;
    item.addEventListener("click", () => openStageDialog(key));
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
  state.pipelineHitRegions = [];

  const language = pipelineLanguage();
  const model = getPipelineModel(language);
  const margin = 22;
  const gap = 10;
  const cardHeight = 56;
  const width = Math.max(96, (rect.width - margin * 2 - gap * (model.length - 1)) / model.length);
  const y = rect.height >= 200 ? 74 : 50;
  const stageMap = new Map((stages || []).map((stage) => [normalizeStageInfoKey(stage.id), stage]));

  ctx.lineWidth = 2;
  ctx.strokeStyle = "#cfd8d2";
  for (let index = 0; index < model.length - 1; index += 1) {
    const x1 = margin + index * (width + gap) + width;
    const x2 = margin + (index + 1) * (width + gap);
    ctx.beginPath();
    ctx.moveTo(x1, y + cardHeight / 2);
    ctx.lineTo(x2, y + cardHeight / 2);
    ctx.stroke();
  }

  model.forEach((step, index) => {
    const x = margin + index * (width + gap);
    const stage = stageMap.get(step.key);
    state.pipelineHitRegions.push({ key: step.key, x, y, width, height: cardHeight });
    ctx.fillStyle = step.color;
    ctx.beginPath();
    roundRect(ctx, x, y, width, cardHeight, 8);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 12px system-ui";
    ctx.fillText(step.label, x + 10, y + 23);
    ctx.font = "11px system-ui";
    const status = index === 0 ? "editor" : stage ? (stage.ok ? `${stage.durationMs} ms` : "stopped") : "pending";
    ctx.fillText(status, x + 10, y + 41);
  });

  ctx.fillStyle = "#66706d";
  ctx.font = "12px system-ui";
  ctx.fillText(
    language === "python"
      ? "Python artifacts are CPython bytecode and interpreter-level operations, with uv project context when available."
      : "Real local artifacts. Runtime addresses are assigned later by the loader.",
    margin,
    rect.height >= 200 ? 168 : 136
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
  $("#pipelineCanvas").addEventListener("click", handlePipelineClick);
  $("#pipelineCanvas").addEventListener("mousemove", updatePipelineCursor);
  $("#pipelineCanvas").addEventListener("mouseleave", () => {
    $("#pipelineCanvas").style.cursor = "default";
  });
  $("#closeStageDialog").addEventListener("click", closeStageDialog);
  $("#stageDialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeStageDialog();
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
