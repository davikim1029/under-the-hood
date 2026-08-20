#!/usr/bin/env python3
"""Detached launcher and health CLI for the Under the Hood viewer."""

from __future__ import annotations

try:
    import readline  # noqa: F401 - nicer arrow-key editing in interactive mode.
except ImportError:
    pass

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parent
LOG_DIR = ROOT / "logs"
PID_FILE = LOG_DIR / "under_the_hood.pid"
LOG_FILE = LOG_DIR / "under_the_hood.log"
DEFAULT_PORT = int(os.environ.get("PORT", "5173"))
DEFAULT_BIND = os.environ.get("UTH_BIND", "tailnet")
HEALTH_PATH = "/api/health"
PORT_SCAN_ATTEMPTS = 21
COMMON_NODE_PATHS = (
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
)


@dataclass
class HealthResult:
    base_url: str
    payload: dict


def parse_ipv4(address: str) -> tuple[int, int, int, int] | None:
    parts = address.split(".")
    if len(parts) != 4:
        return None
    octets: list[int] = []
    for part in parts:
        if not part.isdigit():
            return None
        value = int(part, 10)
        if value < 0 or value > 255:
            return None
        octets.append(value)
    return tuple(octets)  # type: ignore[return-value]


def normalize_host_token(raw: str) -> str:
    token = raw.strip().strip(",;()[]")
    if token.startswith("addr:"):
        token = token[5:]
    if "/" in token:
        token = token.split("/", 1)[0]
    if "%" in token:
        token = token.split("%", 1)[0]
    return token


def is_tailscale_host(hostname: str) -> bool:
    host = normalize_host_token(hostname).lower()
    octets = parse_ipv4(host)
    if octets and octets[0] == 100 and 64 <= octets[1] <= 127:
        return True
    return host.startswith("fd7a:115c:a1e0:")


def format_host_for_url(host: str) -> str:
    return f"[{host}]" if ":" in host and not host.startswith("[") else host


def unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            ordered.append(value)
    return ordered


def detect_tailscale_addresses() -> list[str]:
    candidates: list[str] = []

    try:
        hostname = socket.gethostname()
        for entry in socket.getaddrinfo(hostname, None):
            address = entry[4][0]
            if is_tailscale_host(address):
                candidates.append(normalize_host_token(address))
    except OSError:
        pass

    for command in (["ifconfig"], ["ip", "addr", "show"]):
        if shutil.which(command[0]) is None:
            continue
        try:
            result = subprocess.run(
                command,
                cwd=str(ROOT),
                text=True,
                capture_output=True,
                timeout=3,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        text = f"{result.stdout}\n{result.stderr}"
        for raw in re.split(r"\s+", text):
            token = normalize_host_token(raw)
            if is_tailscale_host(token):
                candidates.append(token)

    def sort_key(address: str) -> tuple[int, str]:
        return (0 if parse_ipv4(address) else 1, address)

    return sorted(unique(candidates), key=sort_key)


def tailnet_url(port: int) -> str:
    addresses = detect_tailscale_addresses()
    return f"http://{format_host_for_url(addresses[0])}:{port}" if addresses else ""


def normalize_base_url(raw_url: str) -> str:
    url = raw_url.strip().rstrip("/")
    if url.endswith(HEALTH_PATH):
        url = url[: -len(HEALTH_PATH)].rstrip("/")
    return url


def candidate_base_urls(port: int, scan_ports: bool = True) -> list[str]:
    ports = range(port, port + PORT_SCAN_ATTEMPTS) if scan_ports else range(port, port + 1)
    urls: list[str] = []

    for key in ("UTH_HEALTH_URL", "UTH_PUBLIC_URL", "UTH_FUNNEL_URL"):
        configured = os.environ.get(key)
        if configured:
            urls.append(normalize_base_url(configured))

    for current_port in ports:
        urls.append(f"http://127.0.0.1:{current_port}")

    for address in detect_tailscale_addresses():
        for current_port in ports:
            urls.append(f"http://{format_host_for_url(address)}:{current_port}")

    return unique(urls)


def fetch_health_at(base_url: str, timeout: float) -> HealthResult:
    request = urllib.request.Request(
        f"{normalize_base_url(base_url)}{HEALTH_PATH}",
        headers={"Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read(1024 * 1024).decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(f"{base_url} returned an unhealthy response")
    return HealthResult(base_url=normalize_base_url(base_url), payload=payload)


def read_health(port: int, timeout: float = 0.5, scan_ports: bool = True) -> HealthResult:
    errors: list[str] = []
    for base_url in candidate_base_urls(port, scan_ports=scan_ports):
        try:
            return fetch_health_at(base_url, timeout=timeout)
        except (OSError, urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, RuntimeError) as error:
            errors.append(f"{base_url}: {error}")

    details = "\n".join(errors[-5:]) if errors else "No candidate URLs were available."
    raise RuntimeError(f"No running viewer answered health.\n{details}")


def best_url(result: HealthResult) -> str:
    urls = result.payload.get("browserUrls") or {}
    return (
        urls.get("funnel")
        or urls.get("public")
        or urls.get("tailnet")
        or urls.get("advertised")
        or urls.get("local")
        or result.base_url
    )


def print_health(result: HealthResult) -> None:
    payload = result.payload
    urls = payload.get("browserUrls") or {}
    print(f"healthy: {'yes' if payload.get('ok') else 'no'}")
    print(f"checked: {result.base_url}")
    print(f"pid: {payload.get('pid', 'unknown')}")
    print(f"platform: {payload.get('platform', 'unknown')}/{payload.get('arch', 'unknown')}")
    print(f"bind: {payload.get('bindHost', 'unknown')} ({payload.get('bindMode', 'unknown')})")
    if payload.get("warning"):
        print(f"warning: {payload['warning']}")
    if urls.get("local"):
        print(f"local: {urls['local']}")
    if urls.get("tailnet"):
        print(f"tailnet: {urls['tailnet']}")
    if urls.get("funnel"):
        print(f"funnel: {urls['funnel']}")
    print(f"advertised: {best_url(result)}")


def read_pid() -> int | None:
    if not PID_FILE.exists():
        return None
    try:
        return int(PID_FILE.read_text(encoding="utf-8").strip())
    except ValueError:
        PID_FILE.unlink(missing_ok=True)
        return None


def pid_is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def managed_pid() -> int | None:
    pid = read_pid()
    if pid is None:
        return None
    if pid_is_running(pid):
        return pid
    PID_FILE.unlink(missing_ok=True)
    return None


def process_command(pid: int) -> str:
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            text=True,
            capture_output=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return result.stdout.strip()


def executable_file(value: str | Path | None) -> bool:
    if not value:
        return False
    try:
        candidate = Path(value).expanduser()
        return candidate.is_file() and os.access(candidate, os.X_OK)
    except OSError:
        return False


def node_from_login_shell() -> str:
    shells = unique([os.environ.get("SHELL", ""), "/bin/zsh", "/bin/bash", "/bin/sh"])
    for shell in shells:
        if not executable_file(shell):
            continue
        try:
            result = subprocess.run(
                [shell, "-lc", "command -v node"],
                text=True,
                capture_output=True,
                timeout=3,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        candidate = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
        if executable_file(candidate):
            return candidate
    return ""


def version_manager_node_paths() -> list[str]:
    home = Path.home()
    paths = [
        home / ".volta" / "bin" / "node",
        home / ".asdf" / "shims" / "node",
        home / ".local" / "bin" / "node",
    ]
    paths.extend(home.glob(".nvm/versions/node/*/bin/node"))
    paths.extend(home.glob("Library/pnpm/nodejs/*/bin/node"))
    return [str(path) for path in paths]


def node_binary() -> str:
    configured = os.environ.get("UTH_NODE") or os.environ.get("NODE_BINARY")
    if configured:
        resolved = shutil.which(configured) if os.sep not in configured else configured
        if executable_file(resolved):
            return str(Path(resolved).expanduser())
        raise SystemExit(f"Configured Node.js binary was not executable: {configured}")

    candidates = [
        shutil.which("node") or "",
        node_from_login_shell(),
        *COMMON_NODE_PATHS,
        *version_manager_node_paths(),
    ]
    for candidate in unique(candidates):
        if executable_file(candidate):
            return str(Path(candidate).expanduser())

    raise SystemExit(
        "Node.js was not found. uv only manages the Python launcher environment; "
        "install Node.js 18+ or set UTH_NODE=/path/to/node."
    )


def start_server(port: int, bind: str, wait_seconds: float) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    pid = managed_pid()
    if pid:
        print(f"Server is already managed by this launcher (PID {pid}).")
        try:
            print(f"URL: {best_url(read_health(port, timeout=0.5))}")
        except RuntimeError as error:
            print(f"Health check did not answer yet: {error}")
        return

    try:
        existing = read_health(port, timeout=0.35)
        print(f"A viewer is already answering health at {existing.base_url} (PID {existing.payload.get('pid')}).")
        print(f"URL: {best_url(existing)}")
        print("No new process was started.")
        return
    except RuntimeError:
        pass

    env = os.environ.copy()
    env["PORT"] = str(port)
    env.setdefault("UTH_BIND", bind)
    command = [node_binary(), "server.mjs"]

    start_line = f"\n--- {datetime.now().astimezone().isoformat(timespec='seconds')} starting {' '.join(command)} ---\n"
    with LOG_FILE.open("ab") as log_file:
        log_file.write(start_line.encode("utf-8"))
        log_file.flush()
        with open(os.devnull, "rb") as devnull:
            process = subprocess.Popen(
                command,
                cwd=str(ROOT),
                env=env,
                stdin=devnull,
                stdout=log_file,
                stderr=log_file,
                start_new_session=True,
                close_fds=True,
            )

    PID_FILE.write_text(str(process.pid), encoding="utf-8")
    print(f"Server started in the background (PID {process.pid}).")
    print(f"PID file: {PID_FILE}")
    print(f"Log file: {LOG_FILE}")

    deadline = time.time() + wait_seconds
    last_error = ""
    while time.time() < deadline:
        exit_code = process.poll()
        if exit_code is not None:
            PID_FILE.unlink(missing_ok=True)
            print(f"The server exited before it became healthy (exit code {exit_code}).")
            tail_log(LOG_FILE, lines=20)
            raise SystemExit(1)
        try:
            result = read_health(port, timeout=0.35)
            print(f"URL: {best_url(result)}")
            return
        except RuntimeError as error:
            last_error = str(error)
            time.sleep(0.3)

    print("The server was started, but health did not answer before the wait timeout.")
    if last_error:
        print(last_error)


def stop_server(force: bool = False) -> None:
    pid = managed_pid()
    if pid is None:
        print("No managed server PID file was found.")
        return

    command = process_command(pid)
    if command and "server.mjs" not in command:
        print(f"PID {pid} is running, but it does not look like this viewer:")
        print(command)
        print("Leaving it alone and removing the stale PID file.")
        PID_FILE.unlink(missing_ok=True)
        return

    try:
        os.killpg(pid, signal.SIGTERM)
        print(f"Sent SIGTERM to process group {pid}.")
    except ProcessLookupError:
        PID_FILE.unlink(missing_ok=True)
        print("Server was already stopped.")
        return
    except PermissionError as error:
        raise SystemExit(f"Permission error stopping server: {error}") from error

    deadline = time.time() + 5
    while time.time() < deadline:
        if not pid_is_running(pid):
            PID_FILE.unlink(missing_ok=True)
            print("Server stopped.")
            return
        time.sleep(0.2)

    if force:
        os.killpg(pid, signal.SIGKILL)
        PID_FILE.unlink(missing_ok=True)
        print("Server force-stopped.")
    else:
        print("Server is still running. Re-run with --force if it does not exit cleanly.")


def check_health(port: int) -> None:
    result = read_health(port, timeout=0.75)
    print_health(result)


def print_url(port: int) -> None:
    try:
        print(best_url(read_health(port, timeout=0.5)))
        return
    except RuntimeError:
        url = tailnet_url(port)
        if url:
            print(url)
            return
    raise SystemExit("No running viewer or Tailscale interface was detected on this machine.")


def tail_log(path: Path = LOG_FILE, lines: int = 40) -> None:
    if not path.exists():
        print(f"Log file not found: {path}")
        return
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in deque(handle, maxlen=lines):
            print(line, end="")


def print_status(port: int) -> None:
    pid = managed_pid()
    if pid:
        print(f"managed process: running (PID {pid})")
    else:
        print("managed process: not running")
    try:
        print_health(read_health(port, timeout=0.5))
    except RuntimeError as error:
        print(f"health: no response ({error})")


def pause() -> None:
    input("\nPress Enter to continue...")


def show_menu(args: argparse.Namespace) -> None:
    while True:
        print("\nUnder the Hood")
        print("1. Start server")
        print("2. Check health")
        print("3. Print URL")
        print("4. Stop server")
        print("5. Show logs")
        print("6. Quit")
        choice = input("\nChoose an option: ").strip().lower()

        try:
            if choice in ("1", "start", "start-server"):
                start_server(args.port, args.bind, args.wait)
                pause()
            elif choice in ("2", "health", "check"):
                check_health(args.port)
                pause()
            elif choice in ("3", "url", "tailscale-url"):
                print_url(args.port)
                pause()
            elif choice in ("4", "stop"):
                stop_server(force=args.force)
                pause()
            elif choice in ("5", "logs", "log"):
                tail_log(lines=args.lines)
                pause()
            elif choice in ("6", "q", "quit", "exit"):
                return
            else:
                print("Unknown option.")
        except (RuntimeError, SystemExit) as error:
            if isinstance(error, SystemExit):
                message = str(error)
                if message:
                    print(message)
            else:
                print(error)
            pause()


def run_mode(mode: str, args: argparse.Namespace) -> None:
    normalized = mode.lower()
    if normalized in ("menu", "interactive"):
        show_menu(args)
    elif normalized in ("start", "start-server", "server"):
        start_server(args.port, args.bind, args.wait)
    elif normalized in ("health", "check"):
        check_health(args.port)
    elif normalized in ("status",):
        print_status(args.port)
    elif normalized in ("url", "tailscale-url", "funnel-url"):
        print_url(args.port)
    elif normalized == "stop":
        stop_server(force=args.force)
    elif normalized in ("logs", "log"):
        tail_log(lines=args.lines)
    else:
        raise SystemExit(f"Unknown mode: {mode}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Under the Hood viewer launcher")
    parser.add_argument("command", nargs="?", help="menu, start-server, health, url, status, stop, or logs")
    parser.add_argument("--mode", help="Mode alias for compatibility with other local launchers")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Viewer port (default: {DEFAULT_PORT})")
    parser.add_argument("--bind", default=DEFAULT_BIND, help=f"Bind mode/host for server start (default: {DEFAULT_BIND})")
    parser.add_argument("--wait", type=float, default=10, help="Seconds to wait for health after starting")
    parser.add_argument("--lines", type=int, default=40, help="Log lines to print")
    parser.add_argument("--force", action="store_true", help="Use SIGKILL if stop does not exit cleanly")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    mode = args.mode or args.command or "menu"
    run_mode(mode, args)


if __name__ == "__main__":
    main()
