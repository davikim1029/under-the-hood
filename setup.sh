#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSUME_YES=0
CHECK_ONLY=0
WITH_TAILSCALE=0
WITH_UV=0
WITH_WINDOWS_FUNNEL=0
WINDOWS_FUNNEL_TARGET_PORT=""
WINDOWS_FUNNEL_HTTPS_PORT="${UTH_FUNNEL_HTTPS_PORT:-443}"
REQUIRED_MISSING=0

usage() {
  cat <<'EOF'
Under the Hood dependency setup

Usage:
  ./setup.sh [options]

Options:
  --check-only       Report missing dependencies without installing anything.
  --yes, -y          Run non-interactively where supported.
  --with-tailscale   Also install the Tailscale CLI/daemon if it is missing.
  --with-uv          Also install uv if it is missing.
  --with-windows-funnel
                     In WSL, configure the Windows Tailscale daemon to Funnel
                     this viewer without overriding active ports.
  --funnel-target-port PORT
                     Windows localhost port for the viewer (default: PORT,
                     .env PORT, or 5173).
  --funnel-https-port PORT
                     Public Funnel HTTPS port: 443, 8443, or 10000
                     (default: UTH_FUNNEL_HTTPS_PORT or 443).
  --help, -h         Show this help.

Required non-Python tools:
  node/npm 18+       Runs the local viewer server.
  clang/nm           Builds and inspects C examples.
  lsof/ps            Reads process metadata.

Optional tools:
  tailscale          Tailnet discovery and Funnel URL detection.
  uv                 Python project-context analysis for pyproject/uv.lock repos.
  objdump/otool      Object disassembly. macOS can use otool as the fallback.
  strace             Save-probe syscall tracing on Linux and WSL.
  vmmap/dtruss       Deeper macOS process/save tracing, subject to OS permissions.
EOF
}

log() {
  printf '\033[1;34m==>\033[0m %s\n' "$*"
}

ok() {
  printf '\033[1;32mOK\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33mWARN\033[0m %s\n' "$*"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

# Mirrors findTailscaleCli() in server.mjs: the CLI is often not on PATH.
resolve_tailscale() {
  if command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
    return 0
  fi
  local candidate
  for candidate in \
    /usr/bin/tailscale \
    /usr/sbin/tailscale \
    /opt/homebrew/bin/tailscale \
    /usr/local/bin/tailscale \
    /Applications/Tailscale.app/Contents/MacOS/Tailscale \
    "$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
    "/mnt/c/Program Files/Tailscale/tailscale.exe" \
    "/mnt/c/Program Files/TailScale/tailscale.exe" \
    "/mnt/c/Program Files (x86)/Tailscale/tailscale.exe"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

env_file_value() {
  local key="$1"
  local env_file="$PROJECT_DIR/.env"
  [[ -f "$env_file" ]] || return 1
  sed -n -E "s/^${key}=//p" "$env_file" | tail -n 1
}

running_in_wsl() {
  [[ "$(uname -s)" == "Linux" ]] || return 1
  if grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null; then
    return 0
  fi
  uname -r | grep -qiE '(microsoft|wsl)'
}

resolve_windows_tailscale() {
  local candidate
  for candidate in \
    "/mnt/c/Program Files/Tailscale/tailscale.exe" \
    "/mnt/c/Program Files/TailScale/tailscale.exe" \
    "/mnt/c/Program Files (x86)/Tailscale/tailscale.exe"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

resolve_windows_curl() {
  if command -v curl.exe >/dev/null 2>&1; then
    command -v curl.exe
    return 0
  fi
  local candidate="/mnt/c/Windows/System32/curl.exe"
  [[ -x "$candidate" ]] && printf '%s\n' "$candidate"
}

resolve_powershell() {
  if command -v powershell.exe >/dev/null 2>&1; then
    command -v powershell.exe
    return 0
  fi
  if command -v pwsh.exe >/dev/null 2>&1; then
    command -v pwsh.exe
    return 0
  fi
  local candidate
  for candidate in \
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" \
    "/mnt/c/Program Files/PowerShell/7/pwsh.exe"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

valid_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 ))
}

fail_setup() {
  warn "$*"
  REQUIRED_MISSING=1
  return 1
}

set_local_env() {
  local key="$1" value="$2" env_file="$PROJECT_DIR/.env" tmp_file
  if [[ "$CHECK_ONLY" == "1" ]]; then
    printf 'would write .env: %s=%s\n' "$key" "$value"
    return 0
  fi
  tmp_file="$(mktemp)"
  if [[ -f "$env_file" ]]; then
    grep -v -E "^${key}=" "$env_file" >"$tmp_file" || true
  fi
  printf '%s=%s\n' "$key" "$value" >>"$tmp_file"
  mv "$tmp_file" "$env_file"
}

ask_yes() {
  local prompt="$1"
  if [[ "$ASSUME_YES" == "1" ]]; then
    return 0
  fi
  read -r -p "$prompt [y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" || "$reply" == "yes" || "$reply" == "YES" ]]
}

run_cmd() {
  if [[ "$CHECK_ONLY" == "1" ]]; then
    printf 'would run:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

sudo_run() {
  if [[ "$(id -u)" == "0" ]]; then
    run_cmd "$@"
  else
    run_cmd sudo "$@"
  fi
}

find_brew() {
  if have brew; then
    command -v brew
    return 0
  fi
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

load_brew_env() {
  local brew_path
  if ! brew_path="$(find_brew)"; then
    return 1
  fi
  eval "$("$brew_path" shellenv)"
  return 0
}

install_homebrew() {
  if [[ "$CHECK_ONLY" == "1" ]]; then
    warn "Homebrew is not installed."
    REQUIRED_MISSING=1
    return 1
  fi
  if ! ask_yes "Homebrew is missing. Install it now?"; then
    warn "Skipping Homebrew install."
    REQUIRED_MISSING=1
    return 1
  fi
  log "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_brew_env
}

ensure_brew() {
  if load_brew_env; then
    return 0
  fi
  install_homebrew
}

brew_install() {
  local name="$1"
  shift || true
  ensure_brew || return 1
  if brew list "$name" >/dev/null 2>&1 || brew list --cask "$name" >/dev/null 2>&1; then
    ok " $name already installed by Homebrew"
    return 0
  fi
  run_cmd brew install "$@" "$name"
}

node_major() {
  if ! have node; then
    printf '0\n'
    return
  fi
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0\n'
}

node_ok() {
  have node && [[ "$(node_major)" -ge 18 ]]
}

ensure_node_macos() {
  if node_ok && have npm; then
    ok " Node $(node --version) and npm $(npm --version)"
    return 0
  fi
  log "Installing Node.js with Homebrew"
  brew_install node
  hash -r
  if node_ok && have npm; then
    ok " Node $(node --version) and npm $(npm --version)"
  else
    warn "Node.js 18+ is still not available on PATH."
    REQUIRED_MISSING=1
  fi
}

ensure_xcode_clt() {
  if xcrun -find clang >/dev/null 2>&1 && have nm; then
    ok " Xcode Command Line Tools available"
    return 0
  fi
  if [[ "$CHECK_ONLY" == "1" ]]; then
    warn "Xcode Command Line Tools are missing."
    REQUIRED_MISSING=1
    return
  fi
  log "Starting Xcode Command Line Tools installer"
  xcode-select --install || true
  warn "Finish the Apple installer, then rerun ./setup.sh."
  REQUIRED_MISSING=1
}

install_tailscale_macos() {
  local existing
  if existing="$(resolve_tailscale)"; then
    ok " Tailscale CLI $existing"
    return 0
  fi
  if [[ "$WITH_TAILSCALE" != "1" ]]; then
    warn "Tailscale CLI not found. Re-run with --with-tailscale to install it."
    return 0
  fi
  log "Installing Tailscale formula with Homebrew"
  brew_install tailscale --formula || brew_install tailscale --cask
  hash -r
  if existing="$(resolve_tailscale)"; then
    ok " Tailscale CLI $existing"
  else
    warn "Tailscale installed, but no CLI was found in the usual locations yet."
  fi
}

install_uv_macos() {
  if have uv; then
    ok " uv $(uv --version)"
    return 0
  fi
  if [[ "$WITH_UV" != "1" ]]; then
    warn "uv not found. Re-run with --with-uv if you want uv project analysis."
    return 0
  fi
  log "Installing uv with Homebrew"
  brew_install uv
}

detect_linux_package_manager() {
  for manager in apt-get dnf yum pacman zypper; do
    if have "$manager"; then
      printf '%s\n' "$manager"
      return 0
    fi
  done
  return 1
}

# Package name for a logical tool, where distros disagree.
package_for() {
  local manager="$1" logical="$2"
  case "$logical" in
    procps)
      case "$manager" in
        dnf|yum|pacman) printf 'procps-ng\n' ;;
        *) printf 'procps\n' ;;
      esac
      ;;
    *)
      printf '%s\n' "$logical"
      ;;
  esac
}

# Only ever install what is actually missing. These machines run other
# services, and blanket-installing nodejs/npm can downgrade or displace an
# existing nvm or NodeSource install that those services depend on.
MISSING_PACKAGES=()
collect_missing_linux_packages() {
  local manager="$1"
  local logical
  MISSING_PACKAGES=()
  for logical in \
    "$(node_ok || printf 'nodejs')" \
    "$(have npm || printf 'npm')" \
    "$(have clang || printf 'clang')" \
    "$(have nm || printf 'binutils')" \
    "$(have lsof || printf 'lsof')" \
    "$(have ps || printf 'procps')" \
    "$(have strace || printf 'strace')"
  do
    if [[ -n "$logical" ]]; then
      MISSING_PACKAGES+=("$(package_for "$manager" "$logical")")
    fi
  done
  return 0
}

install_linux_packages() {
  local manager="$1"
  shift
  if [[ "$#" -eq 0 ]]; then
    ok " No packages needed; everything required is already installed"
    return 0
  fi
  case "$manager" in
    apt-get)
      sudo_run apt-get update
      sudo_run apt-get install -y "$@"
      ;;
    dnf)
      sudo_run dnf install -y "$@"
      ;;
    yum)
      sudo_run yum install -y "$@"
      ;;
    pacman)
      sudo_run pacman -Sy --needed --noconfirm "$@"
      ;;
    zypper)
      sudo_run zypper install -y "$@"
      ;;
    *)
      warn "Unsupported package manager: $manager"
      REQUIRED_MISSING=1
      ;;
  esac
}

ensure_linux_required() {
  local manager
  if node_ok && have npm && have clang && have nm && have lsof && have ps; then
    ok " Required Linux tools are available"
    return 0
  fi
  if ! manager="$(detect_linux_package_manager)"; then
    warn "No supported Linux package manager found."
    REQUIRED_MISSING=1
    return 1
  fi
  collect_missing_linux_packages "$manager"
  if [[ "${#MISSING_PACKAGES[@]}" -eq 0 ]]; then
    ok " Required Linux tools are available"
    return 0
  fi
  log "Installing only the missing packages: ${MISSING_PACKAGES[*]}"
  install_linux_packages "$manager" "${MISSING_PACKAGES[@]}"
  hash -r
  if node_ok && have npm && have clang && have nm && have lsof && have ps; then
    ok " Required Linux tools are available"
  else
    warn "One or more required tools are still missing, or Node.js is older than 18."
    REQUIRED_MISSING=1
  fi
}

install_tailscale_linux() {
  local existing
  if existing="$(resolve_tailscale)"; then
    ok " Tailscale CLI $existing"
    return 0
  fi
  if [[ "$WITH_TAILSCALE" != "1" ]]; then
    warn "Tailscale CLI not found. Re-run with --with-tailscale to install it."
    return 0
  fi
  if ! have curl; then
    warn "curl is required to install Tailscale on Linux."
    REQUIRED_MISSING=1
    return 1
  fi
  if [[ "$CHECK_ONLY" == "1" ]]; then
    warn "Tailscale would be installed from https://tailscale.com/install.sh."
    return 0
  fi
  log "Installing Tailscale using the official Linux install script"
  local installer
  installer="$(mktemp)"
  curl -fsSL https://tailscale.com/install.sh -o "$installer"
  sh "$installer"
  rm -f "$installer"
}

install_uv_linux() {
  if have uv; then
    ok " uv $(uv --version)"
    return 0
  fi
  if [[ "$WITH_UV" != "1" ]]; then
    warn "uv not found. Re-run with --with-uv if you want uv project analysis."
    return 0
  fi
  local manager
  if manager="$(detect_linux_package_manager)"; then
    case "$manager" in
      apt-get) sudo_run apt-get install -y uv || true ;;
      dnf) sudo_run dnf install -y uv || true ;;
      yum) sudo_run yum install -y uv || true ;;
      pacman) sudo_run pacman -Sy --needed --noconfirm uv || true ;;
      zypper) sudo_run zypper install -y uv || true ;;
    esac
  fi
  if ! have uv; then
    warn "uv was not installed by the system package manager. Install from https://docs.astral.sh/uv/ if needed."
  fi
}

windows_health_json() {
  local port="$1" curl_path powershell_path
  if curl_path="$(resolve_windows_curl)"; then
    "$curl_path" -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" 2>/dev/null
    return $?
  fi
  if powershell_path="$(resolve_powershell)"; then
    "$powershell_path" -NoProfile -NonInteractive -Command \
      "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:${port}/api/health').Content; exit 0 } catch { exit 1 }" \
      2>/dev/null
    return $?
  fi
  return 2
}

windows_viewer_health_matches() {
  local port="$1" payload
  payload="$(windows_health_json "$port")" || return 1
  printf '%s' "$payload" | node -e '
const expectedRoot = process.argv[1];
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw);
    process.exit(payload && payload.ok === true && payload.root === expectedRoot ? 0 : 1);
  } catch {
    process.exit(1);
  }
});
' "$PROJECT_DIR"
}

windows_port_listening() {
  local port="$1" powershell_path
  if powershell_path="$(resolve_powershell)"; then
    "$powershell_path" -NoProfile -NonInteractive -Command \
      "\$ErrorActionPreference='SilentlyContinue'; \$listeners = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen; if (\$listeners) { exit 0 } else { exit 1 }" \
      >/dev/null 2>&1
    return $?
  fi
  if [[ -x /mnt/c/Windows/System32/netstat.exe && -x /mnt/c/Windows/System32/findstr.exe ]]; then
    /mnt/c/Windows/System32/cmd.exe /c "netstat -ano -p tcp | findstr /R /C:\":${port} .*LISTENING\"" >/dev/null 2>&1
    return $?
  fi
  return 2
}

ensure_windows_target_port_available() {
  local port="$1" listen_status
  if windows_viewer_health_matches "$port"; then
    ok " Windows localhost:${port} reaches this viewer"
    return 0
  fi

  windows_port_listening "$port"
  listen_status=$?
  if [[ "$listen_status" == "0" ]]; then
    fail_setup "Windows localhost:${port} is already listening, but /api/health did not match this project. Refusing to expose that port with Funnel."
    return 1
  fi
  if [[ "$listen_status" == "2" ]]; then
    fail_setup "Could not inspect Windows localhost:${port}; refusing to configure Funnel because active-port safety could not be verified."
    return 1
  fi

  warn "Windows localhost:${port} is not listening yet. Funnel can be configured now, but start this viewer on PORT=${port} before using the public URL."
  return 0
}

inspect_tailscale_status_file() {
  local file="$1" https_port="$2" target_port="$3"
  node - "$file" "$https_port" "$target_port" <<'NODE'
const fs = require("fs");
const [file, publicPortRaw, targetPortRaw] = process.argv.slice(2);
const publicPort = Number(publicPortRaw);
const targetPort = Number(targetPortRaw);
let config;
try {
  config = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  console.log("empty");
  process.exit(0);
}

function stripIpv6Brackets(hostname) {
  return String(hostname || "").replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
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

function isFunnelAllowed(sourceConfig, hostPort) {
  const allowFunnel = sourceConfig?.AllowFunnel || {};
  if (allowFunnel[hostPort] === true) return true;
  if (allowFunnel[hostPort] === false) return false;
  return Object.keys(allowFunnel).length === 0;
}

function targetMatches(target) {
  const normalized = String(target || "").trim();
  if (!normalized) return false;
  if (normalized === String(targetPort)) return true;
  try {
    const url = new URL(normalized.includes("://") ? normalized : `http://${normalized}`);
    return Number.parseInt(url.port || (url.protocol === "https:" ? "443" : "80"), 10) === targetPort;
  } catch {
    return normalized.endsWith(`:${targetPort}`);
  }
}

function buildUrl(host, port) {
  if (!host || !host.endsWith(".ts.net")) return "";
  return `https://${host}${port && port !== 443 ? `:${port}` : ""}`;
}

const entries = [];
function addEntry(sourceConfig, hostPort, mount = "/", target = "") {
  const parsed = parseHostPort(hostPort);
  entries.push({
    hostPort,
    host: parsed.host,
    port: parsed.port,
    mount,
    target: String(target || ""),
    public: isFunnelAllowed(sourceConfig, hostPort)
  });
}

function collect(sourceConfig) {
  if (!sourceConfig || typeof sourceConfig !== "object") return;
  for (const [hostPort, webConfig] of Object.entries(sourceConfig.Web || {})) {
    const handlers = webConfig?.Handlers || {};
    const mounts = Object.keys(handlers);
    if (!mounts.length) addEntry(sourceConfig, hostPort);
    for (const [mount, handler] of Object.entries(handlers)) {
      addEntry(sourceConfig, hostPort, mount, handler?.Proxy || handler?.TCPForward || handler?.Path || "");
    }
  }
  for (const foreground of Object.values(sourceConfig.Foreground || {})) collect(foreground);
  for (const service of Object.values(sourceConfig.Services || {})) collect(service);
}

collect(config);
const relevant = entries.filter((entry) => entry.port === publicPort);
if (!relevant.length) {
  console.log("empty");
  process.exit(0);
}

const conflicts = relevant.filter((entry) => !targetMatches(entry.target));
if (conflicts.length) {
  const details = conflicts
    .map((entry) => `${entry.hostPort}${entry.mount || "/"} -> ${entry.target || "(unknown target)"}`)
    .join("; ");
  console.log(`conflict\t${details}`);
  process.exit(0);
}

const publicMatch = relevant.find((entry) => entry.public);
const first = publicMatch || relevant[0];
console.log(`${publicMatch ? "match-public" : "match-private"}\t${buildUrl(first.host, first.port)}`);
NODE
}

tailscale_status_file() {
  local cli="$1" command="$2" file="$3"
  "$cli" "$command" status --json >"$file" 2>/dev/null && [[ -s "$file" ]]
}

tailscale_funnel_help() {
  local cli="$1"
  "$cli" funnel --help 2>&1 || true
}

tailscale_cli_version() {
  local cli="$1"
  "$cli" version 2>/dev/null | tr -d '\r' | sed -n -E 's/^([0-9]+)\.([0-9]+)\.([0-9]+).*/\1.\2.\3/p' | head -n 1
}

version_at_least() {
  local actual="$1" required="$2"
  node - "$actual" "$required" <<'NODE'
const [actual, required] = process.argv.slice(2);
function parts(value) {
  return String(value || "").split(".").map((part) => Number.parseInt(part, 10));
}
const a = parts(actual);
const r = parts(required);
for (let index = 0; index < 3; index += 1) {
  const left = Number.isFinite(a[index]) ? a[index] : 0;
  const right = Number.isFinite(r[index]) ? r[index] : 0;
  if (left > right) process.exit(0);
  if (left < right) process.exit(1);
}
process.exit(0);
NODE
}

require_supported_funnel_cli() {
  local cli="$1" version help_text
  version="$(tailscale_cli_version "$cli")"
  if [[ -n "$version" ]]; then
    if version_at_least "$version" "1.52.0"; then
      ok " Windows Tailscale CLI $cli ($version)"
      return 0
    fi
    fail_setup "Windows Tailscale CLI $cli is version $version. Upgrade Windows Tailscale to 1.52+ for the current Funnel syntax."
    return 1
  fi

  help_text="$(tailscale_funnel_help "$cli")"
  if ! grep -q -- '--https' <<<"$help_text"; then
    fail_setup "Could not read the Windows Tailscale CLI version or current Funnel flags from $cli. Run '$cli version' from WSL to verify it."
    return 1
  fi
  ok " Windows Tailscale CLI $cli"
}

run_windows_funnel_command() {
  local cli="$1" https_port="$2" target_port="$3" target_arg output status args

  for target_arg in "$target_port" "localhost:${target_port}"; do
    args=(funnel --bg "--https=${https_port}")
    if [[ "$ASSUME_YES" == "1" ]] && tailscale_funnel_help "$cli" | grep -q -- '--yes'; then
      args+=(--yes)
    fi
    args+=("$target_arg")

    if [[ "$CHECK_ONLY" == "1" ]]; then
      run_cmd "$cli" "${args[@]}"
      return 0
    fi

    set +e
    output="$("$cli" "${args[@]}" 2>&1)"
    status=$?
    set -e
    if [[ "$status" == "0" ]]; then
      [[ -n "$output" ]] && printf '%s\n' "$output"
      return 0
    fi

    warn "tailscale funnel failed with target '${target_arg}': ${output:-exit status $status}"
  done

  return 1
}

write_windows_funnel_env() {
  local target_port="$1" public_url="$2"
  set_local_env PORT "$target_port"
  set_local_env UTH_TRUST_WINDOWS_FUNNEL 1
  if [[ -n "$public_url" ]]; then
    set_local_env UTH_PUBLIC_URL "$public_url"
  fi
}

configure_windows_funnel() {
  [[ "$WITH_WINDOWS_FUNNEL" == "1" ]] || return 0

  if ! running_in_wsl; then
    fail_setup "--with-windows-funnel only runs inside WSL, where the Windows Tailscale daemon is reachable through interop."
    return 1
  fi

  local cli
  if ! cli="$(resolve_windows_tailscale)"; then
    fail_setup "Windows Tailscale CLI was not found under /mnt/c. Install Windows Tailscale first, then rerun setup."
    return 1
  fi
  require_supported_funnel_cli "$cli" || return 1

  if ! valid_port "$WINDOWS_FUNNEL_TARGET_PORT"; then
    fail_setup "Invalid --funnel-target-port: ${WINDOWS_FUNNEL_TARGET_PORT}"
    return 1
  fi
  case "$WINDOWS_FUNNEL_HTTPS_PORT" in
    443|8443|10000) ;;
    *)
      fail_setup "Invalid --funnel-https-port: ${WINDOWS_FUNNEL_HTTPS_PORT}. Tailscale Funnel allows 443, 8443, or 10000."
      return 1
      ;;
  esac

  log "Checking Windows localhost:${WINDOWS_FUNNEL_TARGET_PORT} before configuring Funnel"
  ensure_windows_target_port_available "$WINDOWS_FUNNEL_TARGET_PORT" || return 1

  local funnel_status serve_status funnel_state serve_state public_url
  funnel_status="$(mktemp)"
  serve_status="$(mktemp)"

  if tailscale_status_file "$cli" funnel "$funnel_status"; then
    funnel_state="$(inspect_tailscale_status_file "$funnel_status" "$WINDOWS_FUNNEL_HTTPS_PORT" "$WINDOWS_FUNNEL_TARGET_PORT")"
  else
    funnel_state="empty"
  fi

  case "$funnel_state" in
    match-public*)
      public_url="${funnel_state#*$'\t'}"
      ok " Windows Funnel already points HTTPS ${WINDOWS_FUNNEL_HTTPS_PORT} at localhost:${WINDOWS_FUNNEL_TARGET_PORT}"
      write_windows_funnel_env "$WINDOWS_FUNNEL_TARGET_PORT" "$public_url"
      rm -f "$funnel_status" "$serve_status"
      return 0
      ;;
    conflict*)
      rm -f "$funnel_status" "$serve_status"
      fail_setup "Windows Funnel HTTPS ${WINDOWS_FUNNEL_HTTPS_PORT} is already configured for another target: ${funnel_state#*$'\t'}"
      return 1
      ;;
  esac

  if tailscale_status_file "$cli" serve "$serve_status"; then
    serve_state="$(inspect_tailscale_status_file "$serve_status" "$WINDOWS_FUNNEL_HTTPS_PORT" "$WINDOWS_FUNNEL_TARGET_PORT")"
  else
    serve_state="empty"
  fi
  case "$serve_state" in
    match-*|conflict*)
      rm -f "$funnel_status" "$serve_status"
      fail_setup "Windows Tailscale Serve already owns HTTPS ${WINDOWS_FUNNEL_HTTPS_PORT}: ${serve_state#*$'\t'}. Refusing to make it public with Funnel."
      return 1
      ;;
  esac

  log "Configuring Windows Tailscale Funnel HTTPS ${WINDOWS_FUNNEL_HTTPS_PORT} -> 127.0.0.1:${WINDOWS_FUNNEL_TARGET_PORT}"
  if ! run_windows_funnel_command "$cli" "$WINDOWS_FUNNEL_HTTPS_PORT" "$WINDOWS_FUNNEL_TARGET_PORT"; then
    rm -f "$funnel_status" "$serve_status"
    fail_setup "Windows Tailscale Funnel command failed after trying both '${WINDOWS_FUNNEL_TARGET_PORT}' and 'localhost:${WINDOWS_FUNNEL_TARGET_PORT}'. The tailnet may need Funnel policy/HTTPS enabled, or Windows Tailscale may need an update."
    return 1
  fi

  if [[ "$CHECK_ONLY" == "1" ]]; then
    rm -f "$funnel_status" "$serve_status"
    return 0
  fi

  if tailscale_status_file "$cli" funnel "$funnel_status"; then
    funnel_state="$(inspect_tailscale_status_file "$funnel_status" "$WINDOWS_FUNNEL_HTTPS_PORT" "$WINDOWS_FUNNEL_TARGET_PORT")"
  else
    funnel_state="empty"
  fi
  if [[ "$funnel_state" != match-public* ]]; then
    rm -f "$funnel_status" "$serve_status"
    fail_setup "Windows Funnel command finished, but status did not show a public mapping for localhost:${WINDOWS_FUNNEL_TARGET_PORT}."
    return 1
  fi

  public_url="${funnel_state#*$'\t'}"
  write_windows_funnel_env "$WINDOWS_FUNNEL_TARGET_PORT" "$public_url"
  ok " Windows Funnel configured${public_url:+ at $public_url}"
  rm -f "$funnel_status" "$serve_status"
}

check_optional_tools() {
  if have objdump || have otool; then
    ok " Object disassembler available"
  else
    warn "Neither objdump nor otool was found; machine-code disassembly will be limited."
  fi

  case "$(uname -s)" in
    Darwin)
      have vmmap && ok " vmmap available" || warn "vmmap not found; PID Map will still show ps/lsof output."
      have dtruss && ok " dtruss available" || warn "dtruss not found; save syscall tracing will be unavailable."
      ;;
    Linux)
      if [[ -r /proc/self/maps ]]; then
        ok " /proc memory maps readable"
      else
        warn "/proc is not readable; the PID Map view will fall back to ps/lsof output."
      fi
      have strace && ok " strace available" || warn "strace not found; save syscall tracing will be unavailable."
      ;;
  esac

  local tailscale_cli
  if tailscale_cli="$(resolve_tailscale)"; then
    ok " Tailscale CLI $tailscale_cli"
    if [[ "$tailscale_cli" == /mnt/* ]]; then
      warn "That is the Windows Tailscale CLI seen through WSL interop; use --with-windows-funnel to configure it safely for this viewer."
    fi
  else
    warn "Tailscale CLI unavailable; Tailnet discovery/Funnel detection will be limited."
  fi
  if running_in_wsl; then
    local windows_tailscale_cli windows_tailscale_version
    if windows_tailscale_cli="$(resolve_windows_tailscale)"; then
      windows_tailscale_version="$(tailscale_cli_version "$windows_tailscale_cli" || true)"
      ok " Windows Tailscale CLI ${windows_tailscale_cli}${windows_tailscale_version:+ ($windows_tailscale_version)}"
    else
      warn "Windows Tailscale CLI not found under /mnt/c; Windows-level Funnel setup will be unavailable."
    fi
  fi
  have uv && ok " uv available" || warn "uv unavailable; Python analysis will fall back to plain python."
}

print_versions() {
  log "Detected tool versions"
  have node && printf 'node: %s (%s)\n' "$(node --version)" "$(command -v node)" || printf 'node: missing\n'
  have npm && printf 'npm: %s (%s)\n' "$(npm --version)" "$(command -v npm)" || printf 'npm: missing\n'
  have clang && printf 'clang: %s (%s)\n' "$(clang --version | head -n 1)" "$(command -v clang)" || printf 'clang: missing\n'
  have nm && printf 'nm: %s\n' "$(command -v nm)" || printf 'nm: missing\n'
  have lsof && printf 'lsof: %s\n' "$(command -v lsof)" || printf 'lsof: missing\n'
  resolve_tailscale >/dev/null 2>&1 && printf 'tailscale: %s\n' "$(resolve_tailscale)" || true
  if running_in_wsl; then
    local windows_tailscale_cli windows_tailscale_version
    if windows_tailscale_cli="$(resolve_windows_tailscale)"; then
      windows_tailscale_version="$(tailscale_cli_version "$windows_tailscale_cli" || true)"
      printf 'windows tailscale: %s%s\n' "$windows_tailscale_cli" "${windows_tailscale_version:+ ($windows_tailscale_version)}"
    fi
  fi
  have uv && printf 'uv: %s\n' "$(uv --version)" || true
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check-only) CHECK_ONLY=1 ;;
      --yes|-y) ASSUME_YES=1 ;;
      --with-tailscale) WITH_TAILSCALE=1 ;;
      --with-uv) WITH_UV=1 ;;
      --with-windows-funnel) WITH_WINDOWS_FUNNEL=1 ;;
      --funnel-target-port)
        shift
        if [[ $# -eq 0 ]]; then
          printf 'Missing value for --funnel-target-port\n\n'
          usage
          exit 2
        fi
        WINDOWS_FUNNEL_TARGET_PORT="$1"
        ;;
      --funnel-https-port)
        shift
        if [[ $# -eq 0 ]]; then
          printf 'Missing value for --funnel-https-port\n\n'
          usage
          exit 2
        fi
        WINDOWS_FUNNEL_HTTPS_PORT="$1"
        ;;
      --help|-h) usage; exit 0 ;;
      *) printf 'Unknown option: %s\n\n' "$1"; usage; exit 2 ;;
    esac
    shift
  done

  cd "$PROJECT_DIR"
  if [[ -z "$WINDOWS_FUNNEL_TARGET_PORT" ]]; then
    WINDOWS_FUNNEL_TARGET_PORT="${PORT:-}"
  fi
  if [[ -z "$WINDOWS_FUNNEL_TARGET_PORT" ]]; then
    WINDOWS_FUNNEL_TARGET_PORT="$(env_file_value PORT || true)"
  fi
  WINDOWS_FUNNEL_TARGET_PORT="${WINDOWS_FUNNEL_TARGET_PORT:-5173}"

  log "Setting up Under the Hood dependencies"

  case "$(uname -s)" in
    Darwin)
      ensure_xcode_clt
      ensure_node_macos
      install_tailscale_macos
      install_uv_macos
      ;;
    Linux)
      ensure_linux_required
      install_tailscale_linux
      install_uv_linux
      ;;
    *)
      warn "Unsupported OS: $(uname -s). Install Node.js 18+, npm, clang, nm, lsof, and ps manually."
      REQUIRED_MISSING=1
      ;;
  esac

  configure_windows_funnel
  check_optional_tools
  print_versions

  if [[ "$REQUIRED_MISSING" == "1" ]]; then
    warn "Setup finished with missing required pieces."
    exit 1
  fi

  ok " Setup finished. Start the viewer with: python3 main.py --mode start-server"
}

main "$@"
