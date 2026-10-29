'use strict';

const loginScreen = document.querySelector('#login-screen');
const chatScreen = document.querySelector('#chat-screen');
const loginForm = document.querySelector('#login-form');
const nicknameInput = document.querySelector('#nickname');
const loginError = document.querySelector('#login-error');
const roomList = document.querySelector('#room-list');
const messagesEl = document.querySelector('#messages');
const roomTitle = document.querySelector('#room-title');
const messageForm = document.querySelector('#message-form');
const messageInput = document.querySelector('#message-input');
const connectionEl = document.querySelector('.connection');
const connectionLabel = document.querySelector('#connection-label');
const toast = document.querySelector('#toast');
const fileInput = document.querySelector('#file-input');
const attachButton = document.querySelector('#attach-button');

let pendingAttachment = null;
let busyUploading = false;
let nickname = localStorage.getItem('chatik.nickname') || '';
let rooms = [];
let activeRoomId = '';
let socket;
let reconnectTimer;
let toastTimer;
let requestVersion = 0;

nicknameInput.value = nickname;

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  nickname = nicknameInput.value.trim().slice(0, 24);
  if (!nickname) {
    loginError.textContent = 'Введи ник, чтобы продолжить.';
    return;
  }
  localStorage.setItem('chatik.nickname', nickname);
  await enterChat();
});

document.querySelector('#change-name').addEventListener('click', () => {
  if (socket) socket.close();
  chatScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  nicknameInput.value = nickname;
  loginError.textContent = '';
  nicknameInput.focus();
});

document.querySelector('#add-room').addEventListener('click', async () => {
  const name = window.prompt('Название новой комнаты:');
  if (name === null) return;
  if (!name.trim()) return showToast('Название комнаты не может быть пустым.');
  try {
    const room = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) });
    rooms.push(room);
    renderRooms();
    await selectRoom(room.id);
  } catch (error) {
    showToast(error.message);
  }
});

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if ((!text && !pendingAttachment) || busyUploading || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'message', text, attachment: pendingAttachment }));
  messageInput.value = '';
  pendingAttachment = null;
  resizeInput();
  messageInput.focus();
});

attachButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return showToast('Файл слишком большой. Максимальный размер: 10 МБ.');
  busyUploading = true;
  attachButton.disabled = true;
  try {
    const body = new FormData();
    body.append('file', file);
    const response = await fetch('/upload', { method: 'POST', body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Не удалось загрузить файл.');
    pendingAttachment = data;
    showToast(`Прикреплён файл: ${data.name}`);
    messageInput.focus();
  } catch (error) {
    showToast(error.message);
  } finally {
    busyUploading = false;
    attachButton.disabled = false;
  }
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});
messageInput.addEventListener('input', resizeInput);

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.');
  return data;
}

async function enterChat() {
  loginError.textContent = '';
  try {
    rooms = await api('/api/rooms');
    if (!rooms.length) throw new Error('Список комнат пуст. Перезагрузите страницу.');
    loginScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
    document.querySelector('#user-name').textContent = nickname;
    document.querySelector('#user-avatar').textContent = initial(nickname);
    renderRooms();
    const roomId = rooms.some((room) => room.id === activeRoomId) ? activeRoomId : rooms[0].id;
    await selectRoom(roomId);
    connectSocket();
  } catch (error) {
    loginError.textContent = error.message;
  }
}

function renderRooms() {
  roomList.replaceChildren();
  for (const room of rooms) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `room-button${room.id === activeRoomId ? ' active' : ''}`;
    button.setAttribute('aria-label', `Комната: ${room.name}`);
    const hash = document.createElement('span');
    hash.className = 'room-hash';
    hash.textContent = '#';
    const label = document.createElement('span');
    label.textContent = room.name;
    button.append(hash, label);
    button.addEventListener('click', () => selectRoom(room.id));
    roomList.append(button);
  }
}

async function selectRoom(roomId) {
  activeRoomId = roomId;
  const room = rooms.find((item) => item.id === roomId);
  if (!room) return;
  roomTitle.textContent = room.name;
  renderRooms();
  const version = ++requestVersion;
  messagesEl.replaceChildren();
  addEmptyState('Загружаем сообщения…');
  try {
    const messages = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`);
    if (version !== requestVersion) return;
    messagesEl.replaceChildren();
    if (messages.length === 0) addEmptyState('Пока тихо. Напиши первым 👋');
    else messages.forEach(renderMessage);
    scrollToBottom();
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'join', nickname, roomId }));
  } catch (error) {
    if (version === requestVersion) showToast(error.message);
  }
}

function connectSocket() {
  clearTimeout(reconnectTimer);
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${window.location.host}`);
  setConnection('подключение', '');
  socket.addEventListener('open', () => {
    setConnection('на связи', 'online');
    if (activeRoomId) socket.send(JSON.stringify({ type: 'join', nickname, roomId: activeRoomId }));
  });
  socket.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'message' && data.message?.roomId === activeRoomId) {
      removeEmptyState();
      renderMessage(data.message);
      scrollToBottom();
    } else if (data.type === 'error') {
      showToast(data.message || 'Ошибка чата.');
    }
  });
  socket.addEventListener('close', () => {
    setConnection('переподключение', 'offline');
    if (!chatScreen.classList.contains('hidden')) reconnectTimer = setTimeout(connectSocket, 1500);
  });
  socket.addEventListener('error', () => socket.close());
}

function renderMessage(message) {
  const article = document.createElement('article');
  article.className = 'message';
  try {
    const safeMessage = message && typeof message === 'object' ? message : {};
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initial(safeMessage.nickname);
    avatar.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div');
    body.className = 'message-body';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const author = document.createElement('strong');
    author.textContent = typeof safeMessage.nickname === 'string' ? safeMessage.nickname : 'Неизвестный';
    const time = document.createElement('time');
    const date = new Date(safeMessage.createdAt);
    time.dateTime = Number.isNaN(date.getTime()) ? '' : date.toISOString();
    time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.append(author, time);
    body.append(meta);
    if (typeof safeMessage.text === 'string' && safeMessage.text) {
      const text = document.createElement('p');
      text.className = 'message-text';
      text.textContent = safeMessage.text;
      body.append(text);
    }
    renderAttachment(safeMessage.attachment, body);
    article.append(avatar, body);
  } catch (error) {
    console.error('Не удалось отобразить сообщение:', error);
    article.textContent = 'Не удалось отобразить это сообщение.';
  }
  messagesEl.append(article);
}

function renderAttachment(attachment, parent) {
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return;
  const url = typeof attachment.url === 'string' && attachment.url.startsWith('/uploads/') && !attachment.url.includes('..')
    ? attachment.url
    : '';
  if (!url) return;
  const name = typeof attachment.name === 'string' && attachment.name ? attachment.name : 'Вложение';
  const type = typeof attachment.type === 'string' ? attachment.type.toLowerCase() : '';
  const link = document.createElement('a');
  link.href = url;
  if (type.startsWith('image/')) {
    link.className = 'attachment-image-link';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Открыть изображение ${name}`);
    const image = document.createElement('img');
    image.className = 'attachment-image';
    image.alt = name;
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      link.replaceWith(createAttachmentFileLink(url, name, attachment.size));
    }, { once: true });
    image.src = url;
    link.append(image);
  } else {
    return parent.append(createAttachmentFileLink(url, name, attachment.size));
  }
  parent.append(link);
}
function createAttachmentFileLink(url, name, bytes) {
  const link = document.createElement('a');
  link.className = 'attachment-file';
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  const label = document.createElement('span');
  label.className = 'attachment-name';
  label.textContent = name;
  const size = document.createElement('span');
  size.className = 'attachment-size';
  size.textContent = formatSize(bytes);
  link.append(label, size);
  return link;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function addEmptyState(text) {
  const state = document.createElement('div');
  state.className = 'empty-state';
  state.dataset.emptyState = 'true';
  state.textContent = text;
  messagesEl.append(state);
}

function removeEmptyState() {
  messagesEl.querySelector('[data-empty-state]')?.remove();
}

function initial(name) {
  const value = typeof name === 'string' && name.length ? name : '?';
  return [...value][0].toLocaleUpperCase();
}

function setConnection(label, state) {
  connectionLabel.textContent = label;
  connectionEl.classList.remove('online', 'offline');
  if (state) connectionEl.classList.add(state);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function resizeInput() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 130)}px`;
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}
