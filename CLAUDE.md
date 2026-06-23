# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**wshell** — a remote shell web application. It spawns real shell processes via `node-pty` and streams terminal I/O to a browser-based xterm.js terminal over WebSocket. Sessions are persistent: closing the browser tab keeps the shell alive; reopening reconnects and replays scrollback.

## Commands

```bash
# Start the server
npm start                           # defaults to PORT=3000 HOST=127.0.0.1

# Start with the shell script (handles daemonizing, PID file, logging)
./wshell.sh start                   # binds :: (all interfaces), logs to wshell.log
./wshell.sh stop
./wshell.sh restart
./wshell.sh status

# Tail logs
tail -f wshell.log
```

There is no test suite, linter, or build step.

## Architecture

```
Browser (xterm.js)  ←──WebSocket──→  server.js  ──→  SessionManager  ──→  node-pty  ──→  shell process
                    ←──REST API───   (Express)         (session-manager.js)
```

### Backend (two files)

- **`server.js`** — Express HTTP server. Handles:
  - Static file serving from `public/`
  - Bearer-token auth (POST `/api/login`, `/api/logout`, GET `/api/check`). Tokens are UUIDs stored in an in-memory Map with a 24h TTL.
  - REST API for session CRUD (all under `requireAuth` middleware)
  - WebSocket upgrade at `/ws` — auth via `?token=` query param, attaches to existing PTY session by `?sessionId=`

- **`session-manager.js`** — `SessionManager` class. Owns all PTY sessions in a `Map`. Key behaviors:
  - Spawns shells via `node-pty` (defaults to `$WSHELL_SHELL` → `$SHELL` → `/bin/zsh`)
  - Pipes PTY output into an in-memory `buffer` (array of string chunks) with line-count-based trimming to `WSHELL_SCROLLBACK` (default 10,000 lines)
  - On WebSocket attach, replays the full buffer (`replay` message), then streams live output (`output` messages)
  - Session lifecycle: idle detached sessions expire after `WSHELL_SESSION_TTL_MINUTES` (30 min); exited sessions after `WSHELL_EXIT_TTL_MINUTES` (5 min). A periodic cleanup timer runs every 60s.

### Frontend (`public/index.html`)

Single self-contained HTML file. No framework — vanilla JS with xterm.js ES modules vendored in `public/vendor/`.

- Loads xterm with `FitAddon` and `WebLinksAddon`
- Auth: login form → POST `/api/login` → stores Bearer token in `localStorage` → hides login overlay
- Session restore: reads session ID from `window.location.hash` on load, reconnects WebSocket
- Auto-scroll: `MutationObserver` on `.xterm-viewport` scrolls to bottom only when `scrollHeight` changes (new output lines added)
- Reconnection: exponential backoff (1s → 2s → 4s → … capped at 30s) with "Connection lost" / "Reconnected" overlays
- Heartbeat: `ping` WebSocket message every 30s

### WebSocket protocol

| Direction | Message |
|-----------|---------|
| Client → Server | `{ type: "input", data: string }` |
| Client → Server | `{ type: "resize", cols: number, rows: number }` |
| Client → Server | `{ type: "ping" }` |
| Server → Client | `{ type: "replay", lines: string[] }` — full scrollback on connect |
| Server → Client | `{ type: "reconnected" }` — replay complete, session is live |
| Server → Client | `{ type: "output", data: string }` — live PTY output |
| Server → Client | `{ type: "exit", exitCode: number, signal: number }` |
| Server → Client | `{ type: "pong" }` |

### Vendored frontend dependencies

`public/vendor/` contains xterm.js and addons copied from `node_modules/`. These are manually vendored — there is no bundler or copy step. The files are:
- `xterm.mjs`, `xterm.css` (from `@xterm/xterm`)
- `addon-fit.mjs` (from `@xterm/addon-fit`)
- `addon-web-links.mjs` (from `@xterm/addon-web-links`)

### Shell script (`wshell.sh`)

Start/stop/restart/status helper. Uses `nohup` to daemonize, writes PID to `/tmp/wshell.pid`, logs to `./wshell.log`. Reads `PORT`, `HOST`, `WSHELL_SCROLLBACK`, `WSHELL_SESSION_TTL_MINUTES`, and `WSHELL_EXIT_TTL_MINUTES` from the environment.

## Configuration

All via environment variables (see `.env.example`). `dotenv` loads `.env` at startup.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `127.0.0.1` | Bind address |
| `WSHELL_USERNAME` | `admin` | Login username |
| `WSHELL_PASSWORD` | `admin` | Login password |
| `WSHELL_SHELL` | `$SHELL` or `/bin/zsh` | Shell to spawn |
| `WSHELL_SCROLLBACK` | `10000` | Max scrollback lines per session |
| `WSHELL_SESSION_TTL_MINUTES` | `30` | Idle detached session timeout |
| `WSHELL_EXIT_TTL_MINUTES` | `5` | Exited session cleanup delay |

## Development notes

- Project uses ES modules (`"type": "module"` in package.json).
- `node-pty` has native components; the `postinstall` script ensures the spawn-helper binary is executable.
- The server binds to `127.0.0.1` by default — set `HOST=0.0.0.0` or `HOST=::` for remote access. The shell script defaults to `::`.
- Auth tokens are in-memory only and do not survive server restarts. All sessions are destroyed on shutdown.
