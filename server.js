'use strict';

const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parsePort(process.env.PORT);
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'chatik.sqlite');
const MAX_MESSAGE_LENGTH = 2000;
const MAX_NICK_LENGTH = 24;
const MAX_ROOM_NAME_LENGTH = 40;
const HISTORY_LIMIT = 100;

function parsePort(value) {
  if (value === undefined || value === '') return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    nickname TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS messages_room_id_id ON messages(room_id, id DESC);
`);

const roomCount = db.prepare('SELECT COUNT(*) AS count FROM rooms').get().count;
if (roomCount === 0) {
  db.prepare('INSERT INTO rooms (id, name) VALUES (?, ?)').run('general', 'Общий');
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const listRooms = db.prepare('SELECT id, name FROM rooms ORDER BY created_at, name');
const roomById = db.prepare('SELECT id, name FROM rooms WHERE id = ?');
const createRoom = db.prepare('INSERT INTO rooms (id, name) VALUES (?, ?)');
const roomHistory = db.prepare(`
  SELECT id, room_id AS roomId, nickname, text, created_at AS createdAt
  FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?
`);
const insertMessage = db.prepare(`
  INSERT INTO messages (room_id, nickname, text) VALUES (?, ?, ?)
`);

app.get('/api/rooms', (_req, res) => res.json(listRooms.all()));
app.post('/api/rooms', (req, res) => {
  const name = cleanText(req.body?.name, MAX_ROOM_NAME_LENGTH);
  if (!name) return res.status(400).json({ error: 'Введите название комнаты.' });
  const existing = db.prepare('SELECT id, name FROM rooms WHERE name = ? COLLATE NOCASE').get(name);
  if (existing) return res.status(409).json({ error: 'Комната с таким названием уже есть.' });
  const id = randomUUID();
  createRoom.run(id, name);
  res.status(201).json({ id, name });
});
app.get('/api/rooms/:roomId/messages', (req, res) => {
  if (!roomById.get(req.params.roomId)) return res.status(404).json({ error: 'Комната не найдена.' });
  const messages = roomHistory.all(req.params.roomId, HISTORY_LIMIT).reverse();
  res.json(messages);
});
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('*', (_req, res, next) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (error) => error && next(error));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const clientsByRoom = new Map();

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, maxLength);
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function leaveRoom(ws) {
  if (!ws.roomId) return;
  const roomClients = clientsByRoom.get(ws.roomId);
  if (roomClients) {
    roomClients.delete(ws);
    if (roomClients.size === 0) clientsByRoom.delete(ws.roomId);
  }
  ws.roomId = null;
}

function broadcast(roomId, payload) {
  const clients = clientsByRoom.get(roomId);
  if (!clients) return;
  const encoded = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(encoded);
  }
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.lastSentAt = 0;
  ws.on('message', (buffer) => {
    let data;
    try { data = JSON.parse(buffer.toString()); } catch { return send(ws, { type: 'error', message: 'Некорректный формат сообщения.' }); }
    if (!data || typeof data !== 'object') return;

    if (data.type === 'join') {
      const nickname = cleanText(data.nickname, MAX_NICK_LENGTH);
      const roomId = typeof data.roomId === 'string' ? data.roomId : '';
      const room = roomById.get(roomId);
      if (!nickname) return send(ws, { type: 'error', message: 'Укажите ник длиной до 24 символов.' });
      if (!room) return send(ws, { type: 'error', message: 'Комната не найдена.' });
      leaveRoom(ws);
      ws.nickname = nickname;
      ws.roomId = room.id;
      if (!clientsByRoom.has(room.id)) clientsByRoom.set(room.id, new Set());
      clientsByRoom.get(room.id).add(ws);
      send(ws, { type: 'joined', room });
      return;
    }

    if (data.type === 'message') {
      if (!ws.roomId || !ws.nickname) return send(ws, { type: 'error', message: 'Сначала выберите комнату.' });
      const now = Date.now();
      if (now - ws.lastSentAt < 350) return send(ws, { type: 'error', message: 'Не отправляйте сообщения слишком часто.' });
      const text = cleanText(data.text, MAX_MESSAGE_LENGTH);
      if (!text) return;
      ws.lastSentAt = now;
      const result = insertMessage.run(ws.roomId, ws.nickname, text);
      const row = db.prepare(`SELECT id, room_id AS roomId, nickname, text, created_at AS createdAt FROM messages WHERE id = ?`).get(result.lastInsertRowid);
      broadcast(ws.roomId, { type: 'message', message: row });
    }
  });
  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

server.listen(PORT, HOST, () => console.log(`Chatik is listening on http://${HOST}:${PORT}`));

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
