/**
 * Real-Time Chat Application — server.js
 * Task-04, ProDigy InfoTech
 *
 * Express serves the static client and handles account creation / login
 * and file uploads over plain HTTP. The `ws` library provides the
 * WebSocket layer for everything real-time: joining rooms, sending
 * messages, presence, and notifications.
 *
 * Data (users + chat history) is persisted to simple JSON files under
 * /data so history survives a server restart. This keeps the project
 * dependency-free (no database) for easy local setup and grading.
 */
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer } = require("ws");

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 4MB
const DEFAULT_ROOMS = ["general", "random"];

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---- Persistent stores ----
// users: { [username]: { salt, hash } }
let users = loadJson(USERS_FILE, {});
// messages: { [conversationKey]: [ {from, text, fileUrl, fileName, mime, ts} ] }
let messages = loadJson(MESSAGES_FILE, {});
for (const r of DEFAULT_ROOMS) {
  const key = "room:" + r;
  if (!messages[key]) messages[key] = [];
}
saveJson(MESSAGES_FILE, messages);

// ---- Password hashing (scrypt, built into Node — no extra dependency) ----
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}

// ---- Session tokens (in-memory; reset on server restart) ----
const tokens = new Map(); // token -> username
function issueToken(username) {
  const token = crypto.randomBytes(24).toString("hex");
  tokens.set(token, username);
  return token;
}

function dmKey(a, b) {
  return "dm:" + [a, b].sort().join("|");
}

// ---- Express app ----
const app = express();
app.use(express.json({ limit: "6mb" })); // room for base64-encoded file uploads
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

app.post("/api/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || typeof username !== "string" || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 3-20 characters: letters, numbers, underscore." });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }
  if (users[username]) {
    return res.status(409).json({ error: "That username is already taken." });
  }
  users[username] = hashPassword(password);
  saveJson(USERS_FILE, users);
  const token = issueToken(username);
  res.json({ token, username });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const record = users[username];
  if (!record || !verifyPassword(password || "", record.salt, record.hash)) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  const token = issueToken(username);
  res.json({ token, username });
});

// File/image upload: accepts base64 data, validates size + type, writes to /uploads
app.post("/api/upload", (req, res) => {
  const { token, filename, mime, dataBase64 } = req.body || {};
  const username = tokens.get(token);
  if (!username) return res.status(401).json({ error: "Not authenticated." });
  if (!dataBase64 || !filename || !mime) return res.status(400).json({ error: "Missing file data." });
  const allowed = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"];
  if (!allowed.includes(mime)) return res.status(400).json({ error: "File type not allowed." });
  const buffer = Buffer.from(dataBase64, "base64");
  if (buffer.length > MAX_UPLOAD_BYTES) return res.status(400).json({ error: "File too large (max 4MB)." });
  const safeName = Date.now() + "-" + filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  fs.writeFileSync(path.join(UPLOAD_DIR, safeName), buffer);
  res.json({ url: "/uploads/" + safeName, filename, mime });
});

app.get("/api/rooms", (req, res) => {
  const roomKeys = Object.keys(messages).filter(k => k.startsWith("room:"));
  res.json({ rooms: roomKeys.map(k => k.slice(5)) });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// clientsByUser: username -> Set of ws connections (a user may have multiple tabs)
const clientsByUser = new Map();
const socketMeta = new Map(); // ws -> { username, rooms:Set }

function broadcastPresence() {
  const online = [...clientsByUser.keys()];
  const payload = JSON.stringify({ type: "presence", online });
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function sendTo(username, payload) {
  const set = clientsByUser.get(username);
  if (!set) return false;
  const raw = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(raw);
  return true;
}

function broadcastToRoom(room, payload, exceptWs) {
  const raw = JSON.stringify(payload);
  for (const [ws, meta] of socketMeta.entries()) {
    if (ws !== exceptWs && meta.rooms.has(room) && ws.readyState === ws.OPEN) ws.send(raw);
  }
}

wss.on("connection", (ws) => {
  socketMeta.set(ws, { username: null, rooms: new Set() });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const meta = socketMeta.get(ws);

    if (msg.type === "auth") {
      const username = tokens.get(msg.token);
      if (!username) { ws.send(JSON.stringify({ type: "error", message: "Invalid session, please log in again." })); return; }
      meta.username = username;
      if (!clientsByUser.has(username)) clientsByUser.set(username, new Set());
      clientsByUser.get(username).add(ws);
      ws.send(JSON.stringify({ type: "authed", username, rooms: DEFAULT_ROOMS, users: Object.keys(users) }));
      broadcastPresence();
      return;
    }

    if (!meta.username) { ws.send(JSON.stringify({ type: "error", message: "Authenticate first." })); return; }

    if (msg.type === "join") {
      const room = "room:" + String(msg.room || "").trim().toLowerCase();
      if (!messages[room]) { messages[room] = []; saveJson(MESSAGES_FILE, messages); }
      meta.rooms.add(room);
      ws.send(JSON.stringify({ type: "history", conversation: room, messages: messages[room].slice(-100) }));
      return;
    }

    if (msg.type === "open_dm") {
      const other = String(msg.with || "").trim();
      if (!users[other]) { ws.send(JSON.stringify({ type: "error", message: "No such user." })); return; }
      const key = dmKey(meta.username, other);
      if (!messages[key]) { messages[key] = []; saveJson(MESSAGES_FILE, messages); }
      meta.rooms.add(key);
      ws.send(JSON.stringify({ type: "history", conversation: key, messages: messages[key].slice(-100), with: other }));
      return;
    }

    if (msg.type === "message") {
      const text = String(msg.text || "").trim();
      if (!text || text.length > 2000) return;
      const conversation = msg.dmWith ? dmKey(meta.username, msg.dmWith) : "room:" + String(msg.room || "").trim().toLowerCase();
      if (!messages[conversation]) messages[conversation] = [];
      const entry = { from: meta.username, text, ts: Date.now() };
      messages[conversation].push(entry);
      if (messages[conversation].length > 500) messages[conversation].shift();
      saveJson(MESSAGES_FILE, messages);
      const payload = { type: "message", conversation, ...entry };
      if (msg.dmWith) {
        sendTo(meta.username, payload);
        sendTo(msg.dmWith, payload);
      } else {
        broadcastToRoom(conversation, payload);
        ws.send(JSON.stringify(payload)); // echo to sender too
      }
      return;
    }

    if (msg.type === "file_message") {
      // client already POSTed the file to /api/upload and has a URL
      const { url, filename, mime } = msg;
      if (!url) return;
      const conversation = msg.dmWith ? dmKey(meta.username, msg.dmWith) : "room:" + String(msg.room || "").trim().toLowerCase();
      if (!messages[conversation]) messages[conversation] = [];
      const entry = { from: meta.username, fileUrl: url, fileName: filename, mime, ts: Date.now() };
      messages[conversation].push(entry);
      saveJson(MESSAGES_FILE, messages);
      const payload = { type: "message", conversation, ...entry };
      if (msg.dmWith) { sendTo(meta.username, payload); sendTo(msg.dmWith, payload); }
      else { broadcastToRoom(conversation, payload); ws.send(JSON.stringify(payload)); }
      return;
    }

    if (msg.type === "typing") {
      const conversation = msg.dmWith ? dmKey(meta.username, msg.dmWith) : "room:" + String(msg.room || "").trim().toLowerCase();
      const payload = { type: "typing", conversation, from: meta.username };
      if (msg.dmWith) sendTo(msg.dmWith, payload);
      else broadcastToRoom(conversation, payload, ws);
      return;
    }
  });

  ws.on("close", () => {
    const meta = socketMeta.get(ws);
    socketMeta.delete(ws);
    if (meta && meta.username) {
      const set = clientsByUser.get(meta.username);
      if (set) {
        set.delete(ws);
        if (set.size === 0) clientsByUser.delete(meta.username);
      }
      broadcastPresence();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat server running at http://localhost:${PORT}`);
});
