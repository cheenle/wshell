import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { SessionManager } from "./session-manager.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";

// ── Auth config ────────────────────────────────────────────────

const WSHELL_USERNAME = process.env.WSHELL_USERNAME || "admin";
const WSHELL_PASSWORD = process.env.WSHELL_PASSWORD || "admin";
const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours
const tokens = new Map(); // token -> { username, expiresAt }

function createToken(username) {
  const token = randomUUID();
  tokens.set(token, { username, expiresAt: Date.now() + TOKEN_TTL });
  return token;
}

function validateToken(token) {
  if (!token) return null;
  const entry = tokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokens.delete(token);
    return null;
  }
  return entry;
}

// Clean expired tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (now > entry.expiresAt) tokens.delete(token);
  }
}, 60_000).unref?.();

// ── Express setup ──────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const server = createServer(app);
const sessionManager = new SessionManager();

// ── Auth middleware ────────────────────────────────────────────

function requireAuth(req, res, next) {
  // Support Authorization header (Bearer) or ?token= query param
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else {
    token = req.query.token;
  }

  if (!token || !validateToken(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── Auth routes ────────────────────────────────────────────────

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === WSHELL_USERNAME && password === WSHELL_PASSWORD) {
    const token = createToken(username);
    return res.json({ token, username });
  }
  res.status(401).json({ error: "Invalid username or password" });
});

app.post("/api/logout", (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    tokens.delete(authHeader.slice(7));
  }
  res.json({ success: true });
});

app.get("/api/check", (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.query.token;
  if (token && validateToken(token)) {
    return res.json({ valid: true });
  }
  res.status(401).json({ valid: false });
});

// ── REST API (protected) ───────────────────────────────────────

// Create a new session
app.post("/api/sessions", requireAuth, (req, res) => {
  try {
    const { name, cwd, command, shell } = req.body || {};
    if (cwd !== undefined && typeof cwd !== "string") {
      return res.status(400).json({ error: "cwd must be a string" });
    }
    const session = sessionManager.createSession({ shell, cwd, name, command });
    res.status(201).json(session);
  } catch (err) {
    res.status(500).json({ error: "Failed to create session", detail: err.message });
  }
});

// List all sessions
app.get("/api/sessions", requireAuth, (_req, res) => {
  try {
    const sessions = sessionManager.listSessions();
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: "Failed to list sessions", detail: err.message });
  }
});

// Get session details
app.get("/api/sessions/:id", requireAuth, (req, res) => {
  try {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: "Failed to get session", detail: err.message });
  }
});

// Get session buffer (scrollback)
app.get("/api/sessions/:id/buffer", requireAuth, (req, res) => {
  try {
    const buffer = sessionManager.getBuffer(req.params.id);
    if (buffer === null) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json(buffer);
  } catch (err) {
    res.status(500).json({ error: "Failed to get buffer", detail: err.message });
  }
});

// Destroy a session
app.delete("/api/sessions/:id", requireAuth, (req, res) => {
  try {
    const ok = sessionManager.destroySession(req.params.id);
    if (!ok) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to destroy session", detail: err.message });
  }
});

// ── WebSocket upgrade handling ────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // Only handle /ws path
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    // Auth check via token query param
    const token = url.searchParams.get("token");
    if (!token || !validateToken(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const info = sessionManager.getSession(sessionId);
    if (!info) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      sessionManager.attach(sessionId, ws);
    });
  } catch {
    socket.destroy();
  }
});

// ── Start ─────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const isIPv6 = addr.family === "IPv6" || HOST === "::" || HOST.includes(":");

  if (isIPv6) {
    console.log(`wshell running at http://[::1]:${PORT}  (IPv6 localhost)`);
    console.log(`  or http://[${addr.address}]:${PORT}  (all interfaces, IPv4+IPv6)`);
  } else if (HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1") {
    console.log(`wshell running at http://${HOST}:${PORT}`);
    console.log("  (localhost only — set HOST=0.0.0.0 for IPv4, HOST=:: for IPv6 remote)");
  } else {
    console.log(`wshell running at http://${HOST}:${PORT}`);
  }
});

// ── Graceful shutdown ─────────────────────────────────────────

function shutdown() {
  console.log("\nShutting down...");
  sessionManager.shutdown();
  wss.close();
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
