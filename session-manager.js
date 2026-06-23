import { spawn } from "node-pty";
import { randomUUID } from "node:crypto";

const DEFAULT_SCROLLBACK = parseInt(process.env.WSHELL_SCROLLBACK || "10000", 10);
const DEFAULT_SESSION_TTL_MS =
  parseInt(process.env.WSHELL_SESSION_TTL_MINUTES || "30", 10) * 60 * 1000;
const DEFAULT_EXIT_TTL_MS =
  parseInt(process.env.WSHELL_EXIT_TTL_MINUTES || "5", 10) * 60 * 1000;
const DEFAULT_SHELL = process.env.WSHELL_SHELL || process.env.SHELL || "/bin/zsh";

export class SessionManager {
  #sessions = new Map();
  #cleanupTimer = null;

  constructor(opts = {}) {
    this.scrollback = opts.scrollback ?? DEFAULT_SCROLLBACK;
    this.sessionTTL = opts.sessionTTL ?? DEFAULT_SESSION_TTL_MS;
    this.exitTTL = opts.exitTTL ?? DEFAULT_EXIT_TTL_MS;
    this.defaultShell = opts.shell ?? DEFAULT_SHELL;

    // Periodic cleanup of idle/exited sessions
    this.#cleanupTimer = setInterval(() => this.#cleanup(), 60_000);
    if (this.#cleanupTimer.unref) this.#cleanupTimer.unref();
  }

  // ── public API ──────────────────────────────────────────────

  createSession({ shell, cwd, name, command } = {}) {
    const id = randomUUID();
    const sh = shell || this.defaultShell;
    const dir = cwd || process.cwd();
    const sessionName = name || dir.split("/").filter(Boolean).pop() || sh;

    const pty = spawn(sh, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: dir,
      env: { ...process.env, TERM: "xterm-256color" },
    });

    const session = {
      id,
      pty,
      buffer: [],
      connections: new Set(),
      createdAt: Date.now(),
      detachedSince: null,
      cols: 80,
      rows: 24,
      shell: sh,
      exitCode: null,
      exitSignal: null,
      name: sessionName,
      cwd: dir,
      command: command || null,
    };

    // Pipe PTY output → buffer + broadcast
    pty.onData((data) => {
      session.buffer.push(data);
      // Trim buffer by counting lines (approx — count \n chars)
      this.#trimBuffer(session);
      this.#broadcast(session, { type: "output", data });
    });

    // Handle PTY exit
    pty.onExit(({ exitCode, signal }) => {
      session.exitCode = exitCode;
      session.exitSignal = signal;
      this.#broadcast(session, { type: "exit", exitCode, signal });
      // Close all connections cleanly
      for (const ws of session.connections) {
        try { ws.close(1000, "Process exited"); } catch (_) { /* ignore */ }
      }
    });

    // Auto-launch command after spawn (e.g. "claude")
    if (command) {
      pty.write(command + "\n");
    }

    this.#sessions.set(id, session);
    return { id, shell: sh, createdAt: session.createdAt, name: sessionName, cwd: dir, command: command || null };
  }

  getSession(id) {
    const s = this.#sessions.get(id);
    if (!s) return null;
    return {
      id: s.id,
      shell: s.shell,
      createdAt: s.createdAt,
      cols: s.cols,
      rows: s.rows,
      exitCode: s.exitCode,
      exitSignal: s.exitSignal,
      connectionCount: s.connections.size,
      detachedSince: s.detachedSince,
      bufferSize: s.buffer.reduce((n, c) => n + c.length, 0),
      name: s.name,
      cwd: s.cwd,
      command: s.command,
    };
  }

  listSessions() {
    const results = [];
    for (const [, s] of this.#sessions) {
      results.push({
        id: s.id,
        shell: s.shell,
        createdAt: s.createdAt,
        exitCode: s.exitCode,
        exitSignal: s.exitSignal,
        connectionCount: s.connections.size,
        detachedSince: s.detachedSince,
        name: s.name,
        cwd: s.cwd,
        command: s.command,
      });
    }
    return results;
  }

  getBuffer(id) {
    const s = this.#sessions.get(id);
    if (!s) return null;
    return [...s.buffer];
  }

  attach(id, ws) {
    const s = this.#sessions.get(id);
    if (!s) return false;

    s.connections.add(ws);
    s.detachedSince = null;

    // Send full buffer replay first, then the reconnected signal
    if (s.buffer.length > 0) {
      this.#send(ws, { type: "replay", lines: [...s.buffer] });
    }
    this.#send(ws, { type: "reconnected" });

    // If the process already exited, notify immediately
    if (s.exitCode !== null) {
      this.#send(ws, {
        type: "exit",
        exitCode: s.exitCode,
        signal: s.exitSignal,
      });
    }

    // Wire up WebSocket events
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // silently ignore malformed messages
      }

      switch (msg.type) {
        case "input":
          if (s.exitCode === null) {
            s.pty.write(msg.data);
          }
          break;
        case "resize":
          if (msg.cols && msg.rows) {
            // Reject unreasonably small dimensions
            if (msg.cols < 10 || msg.rows < 3) break;
            s.cols = msg.cols;
            s.rows = msg.rows;
            try { s.pty.resize(msg.cols, msg.rows); } catch (_) { /* ignore */ }
          }
          break;
        case "ping":
          this.#send(ws, { type: "pong" });
          break;
      }
    });

    ws.on("close", () => {
      // Only detach if this ws is still tracked (might have been destroyed)
      if (s.connections.has(ws)) {
        this.detach(id, ws);
      }
    });

    ws.on("error", () => {
      if (s.connections.has(ws)) {
        this.detach(id, ws);
      }
    });

    return true;
  }

  detach(id, ws) {
    const s = this.#sessions.get(id);
    if (!s) return;

    s.connections.delete(ws);

    // If no more connections, mark as detached
    if (s.connections.size === 0) {
      s.detachedSince = Date.now();
    }
  }

  writeToPty(id, data) {
    const s = this.#sessions.get(id);
    if (!s || s.exitCode !== null) return false;
    s.pty.write(data);
    return true;
  }

  resizePty(id, cols, rows) {
    const s = this.#sessions.get(id);
    if (!s) return false;
    s.cols = cols;
    s.rows = rows;
    try { s.pty.resize(cols, rows); return true; } catch (_) { return false; }
  }

  destroySession(id) {
    const s = this.#sessions.get(id);
    if (!s) return false;

    // Kill the PTY
    try { s.pty.kill(); } catch (_) { /* already dead */ }

    // Close all connections
    for (const ws of s.connections) {
      try { ws.close(1000, "Session destroyed"); } catch (_) { /* ignore */ }
    }
    s.connections.clear();

    this.#sessions.delete(id);
    return true;
  }

  shutdown() {
    clearInterval(this.#cleanupTimer);
    for (const [id] of this.#sessions) {
      this.destroySession(id);
    }
  }

  // ── private helpers ─────────────────────────────────────────

  #broadcast(session, msg) {
    const data = JSON.stringify(msg);
    for (const ws of session.connections) {
      this.#send(ws, data);
    }
  }

  #send(ws, msg) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
      }
    } catch (_) { /* connection may have dropped */ }
  }

  #trimBuffer(session) {
    // Count total lines by tallying \n characters across all chunks
    let lines = 0;
    for (const chunk of session.buffer) {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === "\n") lines++;
      }
    }

    // Remove oldest chunks until we're under the scrollback limit
    while (lines > this.scrollback && session.buffer.length > 0) {
      const removed = session.buffer.shift();
      for (let i = 0; i < removed.length; i++) {
        if (removed[i] === "\n") lines--;
      }
    }
  }

  #cleanup() {
    const now = Date.now();
    for (const [id, s] of this.#sessions) {
      if (s.exitCode !== null) {
        // Exited sessions: clean up after exit TTL
        if (s.connections.size === 0) {
          const detached = s.detachedSince ?? now;
          if (now - detached > this.exitTTL) {
            this.destroySession(id);
          }
        }
      } else if (s.connections.size === 0 && s.detachedSince !== null) {
        // Idle detached sessions: clean up after session TTL
        if (now - s.detachedSince > this.sessionTTL) {
          this.destroySession(id);
        }
      }
    }
  }
}
