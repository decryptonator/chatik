'use strict';

const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parsePort(process.env.PORT);
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'chatik.sqlite');
const MAX_MESSAGE_LENGTH = 2000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
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
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    author_id TEXT,
    edited INTEGER NOT NULL DEFAULT 0,
    preview_json TEXT
  );
  CREATE INDEX IF NOT EXISTS messages_room_id_id ON messages(room_id, id DESC);
`);
if (!db.prepare('PRAGMA table_info(messages)').all().some((column) => column.name === 'attachment')) {
  db.exec('ALTER TABLE messages ADD COLUMN attachment TEXT');
}
for (const [column, definition] of [['author_id', 'TEXT'], ['edited', 'INTEGER NOT NULL DEFAULT 0'], ['preview_json', 'TEXT']]) {
  if (!db.prepare('PRAGMA table_info(messages)').all().some((item) => item.name === column)) {
    db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition}`);
  }
}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
app.use('/uploads', express.static(UPLOAD_DIR, { dotfiles: 'deny', index: false, fallthrough: false }));

const upload = multer({
  defParamCharset: 'utf8',
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname).slice(0, 16).replace(/[^.\w-]/g, '');
      callback(null, `${randomUUID()}${extension}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

const listRooms = db.prepare('SELECT id, name FROM rooms ORDER BY created_at, name');
const roomById = db.prepare('SELECT id, name FROM rooms WHERE id = ?');
const createRoom = db.prepare('INSERT INTO rooms (id, name) VALUES (?, ?)');
const roomHistory = db.prepare(`
  SELECT id, room_id AS roomId, nickname, text, attachment, created_at AS createdAt, author_id AS authorId, edited, preview_json AS previewJson
  FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?
`);
const messageById = db.prepare(`
  SELECT id, room_id AS roomId, nickname, text, attachment, created_at AS createdAt, author_id AS authorId, edited, preview_json AS previewJson
  FROM messages WHERE id = ?
`);
const insertMessage = db.prepare(`
  INSERT INTO messages (room_id, nickname, text, attachment, author_id) VALUES (?, ?, ?, ?, ?)
`);
const previewCache = new Map();
const PREVIEW_TTL = 60 * 60 * 1000;
const allSockets = new Set();

app.get('/api/rooms', (_req, res) => res.json(listRooms.all()));
app.post('/api/rooms', (req, res) => {
  const name = cleanText(req.body?.name, MAX_ROOM_NAME_LENGTH);
  if (!name) return res.status(400).json({ error: 'Введите название комнаты.' });
  const existing = db.prepare('SELECT id, name FROM rooms WHERE name = ? COLLATE NOCASE').get(name);
  if (existing) return res.status(409).json({ error: 'Комната с таким названием уже есть.' });
  const id = randomUUID();
  createRoom.run(id, name);
  broadcastAll({ type: 'room:created', room: { id, name } });
  res.status(201).json({ id, name });
});
app.put(['/rooms/:roomId', '/api/rooms/:roomId'], (req, res) => {
  const room = roomById.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Комната не найдена.' });
  const name = cleanText(req.body?.name, MAX_ROOM_NAME_LENGTH);
  if (!name) return res.status(400).json({ error: 'Введите название комнаты.' });
  const duplicate = db.prepare('SELECT id FROM rooms WHERE name = ? COLLATE NOCASE AND id != ?').get(name, room.id);
  if (duplicate) return res.status(409).json({ error: 'Комната с таким названием уже есть.' });
  db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(name, room.id);
  const updated = { id: room.id, name };
  broadcastAll({ type: 'room:updated', room: updated });
  res.json(updated);
});
app.delete(['/rooms/:roomId', '/api/rooms/:roomId'], (req, res) => {
  const room = roomById.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Комната не найдена.' });
  if (listRooms.all().length <= 1) return res.status(400).json({ error: 'Нельзя удалить последнюю комнату.' });
  db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  broadcastAll({ type: 'room:deleted', roomId: room.id });
  res.json({ ok: true, roomId: room.id });
});
app.patch(['/messages/:id', '/api/messages/:id'], (req, res) => {
  const id = Number(req.params.id);
  const clientId = cleanText(req.get('x-client-id'), 64);
  const text = cleanText(req.body?.text, MAX_MESSAGE_LENGTH);
  if (!Number.isSafeInteger(id) || id < 1 || !clientId || !text) return res.status(400).json({ error: 'Некорректное сообщение.' });
  const row = messageById.get(id);
  if (!row) return res.status(404).json({ error: 'Сообщение не найдено.' });
  if (row.authorId !== clientId) return res.status(403).json({ error: 'Можно изменить только своё сообщение.' });
  db.prepare('UPDATE messages SET text = ?, edited = 1, preview_json = NULL WHERE id = ?').run(text, id);
  const updated = withAttachment(messageById.get(id));
  broadcast(row.roomId, { type: 'message:updated', message: updated });
  res.json(updated);
});
app.delete(['/messages/:id', '/api/messages/:id'], (req, res) => {
  const id = Number(req.params.id);
  const clientId = cleanText(req.get('x-client-id'), 64);
  if (!Number.isSafeInteger(id) || id < 1 || !clientId) return res.status(400).json({ error: 'Некорректное сообщение.' });
  const row = messageById.get(id);
  if (!row) return res.status(404).json({ error: 'Сообщение не найдено.' });
  if (row.authorId !== clientId) return res.status(403).json({ error: 'Можно удалить только своё сообщение.' });
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  broadcast(row.roomId, { type: 'message:deleted', id, roomId: row.roomId });
  res.json({ ok: true, id });
});
app.get('/api/rooms/:roomId/messages', (req, res) => {
  if (!roomById.get(req.params.roomId)) return res.status(404).json({ error: 'Комната не найдена.' });
  const messages = roomHistory.all(req.params.roomId, HISTORY_LIMIT).reverse();
  res.json(messages.map(withAttachment));
});
app.post('/upload', (req, res) => {
  upload.single('file')(req, res, (error) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Файл слишком большой. Максимальный размер: 10 МБ.' });
    }
    if (error) return res.status(400).json({ error: 'Не удалось загрузить файл. Попробуйте ещё раз.' });
    if (!req.file) return res.status(400).json({ error: 'Выберите файл для отправки.' });
    const originalName = normalizeUploadedFilename(req.file.originalname);
    res.status(201).json({
      url: `/uploads/${encodeURIComponent(req.file.filename)}`,
      name: originalName,
      originalName,
      size: req.file.size,
      type: req.file.mimetype,
    });
  });
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
  return value.trim().replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]/g, '').slice(0, maxLength);
}

function normalizeUploadedFilename(value) {
  const originalName = path.basename(typeof value === 'string' ? value : 'Вложение')
    .replace(/[\\u0000-\\u001f\\u007f]/g, '')
    .trim()
    .slice(0, 255);
  return originalName || 'Вложение';
}

function cleanAttachment(value) {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string' || !value.url.startsWith('/uploads/') || value.url.includes('..')) return null;
  const name = cleanText(value.name, 255);
  const size = Number(value.size);
  const type = cleanText(value.type, 150).toLowerCase();
  if (!name || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_SIZE) return null;
  return { url: value.url, name, originalName: typeof value.originalName === 'string' ? cleanText(value.originalName, 255) : name, size, type };
}

function withAttachment(row) {
  let attachment = null;
  let preview = null;
  try { attachment = row.attachment ? JSON.parse(row.attachment) : null; } catch { attachment = null; }
  try { preview = row.previewJson ? JSON.parse(row.previewJson) : null; } catch { preview = null; }
  const { attachment: _storedAttachment, previewJson: _storedPreview, ...message } = row;
  return { ...message, attachment, preview };
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

function broadcastAll(payload) {
  const encoded = JSON.stringify(payload);
  for (const client of allSockets) if (client.readyState === WebSocket.OPEN) client.send(encoded);
}

function isPrivateAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (kind === 6) {
    const value = address.toLowerCase();
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.');
  }
  return true;
}

function extractFirstUrl(text) {
  const found = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  return found ? found[0].replace(/[),.!?;:]+$/g, '') : '';
}

async function fetchPreview(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { 'user-agent': 'ChatikLinkPreview/1.0', accept: 'text/html' } });
      if (!response.ok || !/^text\/html/i.test(response.headers.get('content-type') || '')) return null;
      const html = (await response.text()).slice(0, 256 * 1024);
      const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => tag);
      const attr = (tag, key) => tag.match(new RegExp(`\\b${key}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2] || '';
      const find = (key) => {
        const item = meta.find((tag) => /^(og:title|twitter:title)$/i.test(attr(tag, 'property') || attr(tag, 'name')) && /title/i.test(attr(tag, 'property') || attr(tag, 'name')));
        return item ? attr(item, key) : '';
      };
      let title = find('content');
      if (!title) title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
      const imageTag = meta.find((tag) => /^(og:image|twitter:image)$/i.test(attr(tag, 'property') || attr(tag, 'name')));
      let image = imageTag ? attr(imageTag, 'content') : '';
      title = decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, 240);
      if (image) {
        try {
          const imageUrl = new URL(decodeEntities(image), url);
          if (['http:', 'https:'].includes(imageUrl.protocol)) image = imageUrl.href;
          else image = '';
        } catch { image = ''; }
      }
      return title || image ? { title: title || url.hostname, image } : null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
}

function decodeEntities(value) {
  return String(value).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function cacheMessagePreview(messageId, roomId, text) {
  const url = extractFirstUrl(text);
  if (!url) return;
  const cached = previewCache.get(url);
  let preview = cached && cached.expires > Date.now() ? cached.value : undefined;
  if (preview === undefined) {
    preview = await fetchPreview(url);
    previewCache.set(url, { value: preview, expires: Date.now() + PREVIEW_TTL });
  }
  if (!preview) return;
  db.prepare('UPDATE messages SET preview_json = ? WHERE id = ?').run(JSON.stringify(preview), messageId);
  broadcast(roomId, { type: 'message:preview', id: messageId, preview });
}

wss.on('connection', (ws) => {
  allSockets.add(ws);
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
      ws.clientId = cleanText(data.clientId, 64);
      if (!ws.clientId) return send(ws, { type: 'error', message: 'Не удалось определить пользователя. Обновите страницу.' });
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
      const attachment = cleanAttachment(data.attachment);
      if (!text && !attachment) return;
      ws.lastSentAt = now;
      const result = insertMessage.run(ws.roomId, ws.nickname, text, attachment ? JSON.stringify(attachment) : null, ws.clientId);
      const row = messageById.get(result.lastInsertRowid);
      const message = withAttachment(row);
      broadcast(ws.roomId, { type: 'message', message });
      void cacheMessagePreview(row.id, ws.roomId, text).catch(() => {});
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
