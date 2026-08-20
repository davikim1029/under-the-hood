#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSUME_YES=0
CHECK_ONLY=0
WITH_TAILSCALE=0
WITH_UV=0
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
    "/mnt/c/Program Files (x86)/Tailscale/tailscale.exe"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
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

install_linux_packages() {
  local manager="$1"
  case "$manager" in
    apt-get)
      sudo_run apt-get update
      sudo_run apt-get install -y nodejs npm clang llvm binutils lsof procps curl ca-certificates strace
      ;;
    dnf)
      sudo_run dnf install -y nodejs npm clang llvm binutils lsof procps-ng curl ca-certificates strace
      ;;
    yum)
      sudo_run yum install -y nodejs npm clang llvm binutils lsof procps-ng curl ca-certificates strace
      ;;
    pacman)
      sudo_run pacman -Sy --needed --noconfirm nodejs npm clang llvm binutils lsof procps-ng curl ca-certificates strace
      ;;
    zypper)
      sudo_run zypper install -y nodejs npm clang llvm binutils lsof procps curl ca-certificates strace
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
  log "Installing required packages with $manager"
  install_linux_packages "$manager"
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
      warn "That is the Windows Tailscale CLI seen through WSL interop; its Funnel target is the Windows host, not this WSL listener."
    fi
  else
    warn "Tailscale CLI unavailable; Tailnet discovery/Funnel detection will be limited."
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
  have uv && printf 'uv: %s\n' "$(uv --version)" || true
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check-only) CHECK_ONLY=1 ;;
      --yes|-y) ASSUME_YES=1 ;;
      --with-tailscale) WITH_TAILSCALE=1 ;;
      --with-uv) WITH_UV=1 ;;
      --help|-h) usage; exit 0 ;;
      *) printf 'Unknown option: %s\n\n' "$1"; usage; exit 2 ;;
    esac
    shift
  done

  cd "$PROJECT_DIR"
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

  check_optional_tools
  print_versions

  if [[ "$REQUIRED_MISSING" == "1" ]]; then
    warn "Setup finished with missing required pieces."
    exit 1
  fi

  ok " Setup finished. Start the viewer with: python3 main.py --mode start-server"
}

main "$@"
