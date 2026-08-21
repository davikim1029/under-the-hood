#!/usr/bin/env sh
# Resolve the Tailscale CLI and run it. The CLI is frequently not on PATH:
# macOS ships it inside the app bundle, and WSL usually has to reach the
# Windows binary through the interop mount.
# Mirrors findTailscaleCli() in server.mjs and resolve_tailscale() in setup.sh.
set -eu

find_cli() {
  if command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
    return 0
  fi
  for candidate in \
    /usr/bin/tailscale \
    /usr/sbin/tailscale \
    /opt/homebrew/bin/tailscale \
    /usr/local/bin/tailscale \
    /Applications/Tailscale.app/Contents/MacOS/Tailscale \
    "$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
    "/mnt/c/Program Files/Tailscale/tailscale.exe" \
    "/mnt/c/Program Files/TailScale/tailscale.exe" \
    "/mnt/c/Program Files (x86)/Tailscale/tailscale.exe"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! CLI="$(find_cli)"; then
  echo "Tailscale CLI not found in PATH or the usual install locations." >&2
  echo "Install Tailscale, or set UTH_FUNNEL_URL to the public URL you want advertised." >&2
  exit 1
fi

case "$CLI" in
  /mnt/*)
    echo "Using the Windows Tailscale CLI through WSL interop ($CLI)." >&2
    echo "Its Serve/Funnel target is Windows loopback, not this WSL listener." >&2
    echo "Verify the Windows target reaches this viewer before trusting the public Funnel URL." >&2
    ;;
esac

exec "$CLI" "$@"
