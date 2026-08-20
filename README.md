# Under the Hood Viewer

A local lab for seeing how source code becomes lower-level artifacts, and how saves show up as bytes on disk.

## What works in this first slice

- Compile C source with the local `clang` toolchain.
- Inspect preprocessed source, LLVM IR, assembly, object disassembly, and symbols.
- Inspect Python source as AST, CPython bytecode, interpreter operations, imports, and code objects.
- Use `uv run --no-sync python` and `uv tree --depth 1` when a selected Python file is inside a nearby `pyproject.toml` or `uv.lock` project.
- Pick out functions and see a lightweight source-level call graph.
- Run a save-focused C demo, then inspect stdout, file metadata, and a hex dump of the saved bytes.
- Optionally record the save's syscalls: `strace` on Linux and WSL, `dtruss` on macOS.
- Inspect a PID with read-only process metadata and memory-map output. Linux and WSL read `/proc/<pid>/maps` directly; macOS shells out to `vmmap` where the OS allows it.
- Select Local or a Tailscale-reachable agent as the machine that performs the work.

## Why it is local

PID attachment, program execution, file tracing, and disassembly need access to your machine's toolchain and OS. A hosted browser app cannot safely or directly do those things.

## Current limitations

- The native compile pipeline is implemented for C first. Python analysis shows CPython bytecode rather than native machine code.
- Native code visibility for Python would require interpreter, JIT, or native-extension tracing.
- Function-level runtime call tracing requires debugger or tracing support, debug symbols, and often elevated permissions.
- The save view shows virtual memory evidence and file offsets. Physical disk addresses are intentionally hidden by modern filesystems, APFS, SSD firmware, caches, and the kernel.
- macOS may block `vmmap`, `dtruss`, or other attachment-style tools for protected processes.
- On Linux and WSL, `/proc/<pid>/maps` is readable only for processes your user owns, unless ptrace scope is relaxed.

## Run

```sh
npm run start-server
```

Open the URL printed in the terminal.

## Setup

Install or check the non-Python dependencies:

```sh
./setup.sh
```

Use `./setup.sh --check-only` for a dry check, or `./setup.sh --with-tailscale` on machines where you also want the script to install the Tailscale CLI/daemon. The required tools are Node.js/npm 18+, `clang`, `nm`, `ps`, and `lsof`. Optional tools include Tailscale, `uv`, `objdump`/`otool`, `strace` (Linux/WSL syscall tracing), and `vmmap`/`dtruss` (macOS).

## CLI

Interactive menu:

```sh
npm run cli
```

Direct commands:

```sh
npm run start-server
npm run health
npm run url
npm run stop-server
npm run restart-server
```

`npm run start-server` uses `main.py` to start `server.mjs` as a detached background process, so the launcher can exit without stopping the viewer. It writes `logs/under_the_hood.pid` and `logs/under_the_hood.log`.

`npm run health` checks the running viewer on localhost or the Tailnet URL. `npm run url` prints the best URL to use for this machine, preferring a detected Funnel URL, then the Tailnet URL. You can also use the wrapper directly:

```sh
python3 main.py --mode start-server
python3 main.py --mode health
python3 main.py --mode url
python3 main.py --mode stop
python3 main.py --mode restart
```

You can invoke the wrapper with `uv run python main.py`, but `uv` only manages the Python launcher environment. The viewer server still requires Node.js 18+. The launcher checks `PATH`, login-shell paths, Homebrew, nvm, asdf, and Volta locations; if needed, set `UTH_NODE=/path/to/node`.

The launcher never kills or replaces another service that already owns a port. If the requested port is occupied, the Node server moves to the next available port and prints the actual URL. For Funnel setups, make sure the Funnel rule proxies to that printed port. Automatic Funnel detection only advertises routes whose Tailscale Serve/Funnel target matches the viewer's active port; otherwise it falls back to the Tailnet URL.

### WSL notes

When running inside WSL, the folder browser and compiler see the WSL filesystem. A Windows Tailscale IP does not automatically forward arbitrary Tailnet ports into WSL. For remote Tailnet access, either run Tailscale inside WSL and use the WSL distro's own Tailscale IP, or configure Windows port forwarding/firewall rules from the Windows Tailscale IP to the WSL listener.

Which side runs Tailscale changes what the viewer can do:

- **Tailscale inside WSL** is the configuration this project is built for. WSL gets its own `100.x.y.z` address, `UTH_BIND=tailnet` binds to it, and Serve/Funnel targets reach the WSL listener directly.
- **Tailscale on Windows only** means WSL has no `100.x.y.z` interface, so `UTH_BIND=tailnet` falls back to localhost and prints a warning. The viewer can still find the Windows CLI at `/mnt/c/Program Files/Tailscale/tailscale.exe` for status and Funnel detection, but that CLI describes the *Windows* node. Its Funnel target is the Windows host, not the WSL listener, so the detected URL is reported with a warning and only works if Windows forwards the port into WSL. Bind with `npm run agent` (`0.0.0.0`) in that setup.

## View the browser over Tailscale

To make this viewer reachable from your other Tailnet devices, start it in Tailnet mode:

```sh
npm run start-server
```

The server detects the machine's Tailscale `100.x.y.z` address from the OS network interfaces and binds directly to that address. It also keeps `http://127.0.0.1:5173` available on the same machine. Open the printed Tailnet URL from another device on the same Tailnet.

If automatic detection misses the Tailnet address, bind explicitly:

```sh
UTH_BIND=100.x.y.z npm start
```

This viewer can compile and run local code, read selected source files, create save-test files, and inspect process metadata. Keep it limited to trusted Tailnet devices and Tailscale ACLs.

## Detect the Funnel URL

Tailscale Funnel exposes a local service to the public internet with a generated `https://machine.tailnet.ts.net` URL. Start the viewer on localhost:

```sh
npm run dev
```

Then, in another shell on the same machine, enable Funnel for the viewer port:

```sh
npm run funnel
```

That script goes through `scripts/tailscale.sh`, which resolves the Tailscale CLI when it is not on `PATH` — inside the macOS app bundle, or under `/mnt/c` when WSL has to reach the Windows install. It honors `PORT`, so it stays aligned if the viewer moved off 5173.

The viewer detects Funnel in this order:

- `UTH_FUNNEL_URL` or `UTH_PUBLIC_URL`, when you want to provide the URL explicitly.
- `TS_CERT_DOMAIN`, which Tailscale sidecar/container setups often provide.
- `tailscale funnel status --json`.
- `tailscale serve status --json`, for configurations where Funnel state is visible through Serve status.

When a matching Funnel entry proxies to the viewer's local port, `/api/health` returns it in `browserUrls.funnel`, and the app header shows it as the public access URL.

Funnel is public internet exposure. Use it only when you are comfortable exposing this local inspection tool beyond the Tailnet.

## Tailnet agents

Run this project on every machine you want to inspect. The viewer talks to the selected agent over HTTP, and Tailscale supplies the private network path.

On the machine where you want the browser UI:

```sh
npm run dev
```

On another Tailnet machine, prefer binding to that machine's Tailscale IP:

```sh
npm run tailnet
```

You can also bind on every interface when the host firewall and network are trusted:

```sh
npm run agent
```

Then add `http://100.x.y.z:5173` or `http://machine-name.tailnet-name.ts.net:5173` in the viewer's Agent URL field and press Connect.

If the `tailscale` CLI is installed on the viewer machine, Discover will use `tailscale status --json` to suggest peers. Discovery does not prove that the Under the Hood agent is running on those peers; Connect performs that health check.

The built-in proxy only forwards known viewer API calls to localhost, Tailscale `100.64.0.0/10` addresses, Tailscale IPv6 addresses, or `.ts.net` MagicDNS names.
# under-the-hood
