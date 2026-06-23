# ⚡ Claude Code Web

Browser-based terminal for managing multiple Claude Code sessions. Built on xterm.js + WebSocket + node-pty. Sessions persist when you close the tab — reconnect anytime.

![](https://img.shields.io/badge/node-%3E%3D18-green) ![](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Dashboard** — sidebar with session list, status indicators (live/detached/exited)
- **Multi-session** — run Claude Code in different project directories simultaneously
- **Persistent** — close the browser, your shell and Claude keep running. Reopen to pick up where you left off
- **Auto-launch** — optionally auto-run `claude` (or any command) when a session starts
- **Scrollback replay** — full terminal history restored on reconnect
- **Collapsible sidebar** — maximize terminal space when you donʼt need the session list
- **Auth** — simple Bearer-token login, configurable credentials

## Quick Start

```bash
git clone git@github.com:cheenle/wshell.git
cd wshell
npm install
cp .env.example .env      # edit credentials if needed
npm start                  # http://127.0.0.1:3000
```

Or daemonize with the shell script:

```bash
./wshell.sh start          # binds :: (all interfaces, dual-stack)
./wshell.sh status
./wshell.sh stop
```

## Configuration

All via environment variables or `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN, `::` for dual-stack) |
| `WSHELL_USERNAME` | `admin` | Login username |
| `WSHELL_PASSWORD` | `admin` | Login password (**change this!**) |
| `WSHELL_SHELL` | `$SHELL` or `/bin/zsh` | Shell to spawn |
| `WSHELL_SCROLLBACK` | `10000` | Max scrollback lines per session |
| `WSHELL_SESSION_TTL_MINUTES` | `30` | Kill idle detached sessions after N minutes |
| `WSHELL_EXIT_TTL_MINUTES` | `5` | Clean up exited sessions after N minutes |

## Usage

1. Open `http://localhost:3000` → login
2. Click **New Session** → enter a project directory → create
3. Claude Code launches automatically in the terminal
4. Create more sessions from the sidebar (+ New Session)
5. Click sidebar items to switch between sessions
6. Use the **◀** button to collapse the sidebar for more terminal space

Exiting Claude (`Ctrl+D` or `/exit`) drops you back to a shell — the session stays alive. Use **Kill Session** to terminate it.

## Architecture

```
Browser (xterm.js)  ←──WebSocket──→  server.js  ──→  SessionManager  ──→  node-pty  ──→  shell
                    ←──REST API───   (Express)       (in-memory)
```

- **`server.js`** — Express HTTP server, Bearer-token auth, REST API, WebSocket upgrade
- **`session-manager.js`** — PTY lifecycle: spawn, buffer, attach/detach, TTL cleanup
- **`public/index.html`** — single-page dashboard, vanilla JS, vendored xterm.js

## API

Authenticated with `Authorization: Bearer <token>` header.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/login` | Get token (`{ username, password }`) |
| `POST` | `/api/logout` | Revoke token |
| `GET` | `/api/check` | Validate token |
| `POST` | `/api/sessions` | Create session (`{ name?, cwd?, command? }`) |
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/sessions/:id` | Session details + buffer size |
| `GET` | `/api/sessions/:id/buffer` | Full scrollback |
| `DELETE` | `/api/sessions/:id` | Kill session |

## License

MIT
