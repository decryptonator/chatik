'use strict';

const loginScreen = document.querySelector('#login-screen');
const chatScreen = document.querySelector('#chat-screen');
const loginForm = document.querySelector('#login-form');
const nicknameInput = document.querySelector('#nickname');
const loginError = document.querySelector('#login-error');
const roomList = document.querySelector('#room-list');
const messagesEl = document.querySelector('#messages');
const roomTitle = document.querySelector('#room-title');
const sidebarCurrentRoom = document.querySelector('#sidebar-current-room');
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
let clientId = localStorage.getItem('chatik.clientId');
if (!clientId) { clientId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`; localStorage.setItem('chatik.clientId', clientId); }
let rooms = [];
let unreadCounts = new Map();
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
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (/\/messages\/\d+(?:\?|$)/.test(url) && ['PATCH', 'DELETE'].includes((options.method || 'GET').toUpperCase())) headers['X-Client-Id'] = clientId;
  const response = await fetch(url, {
    ...options,
    headers,
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
    unreadCounts = new Map(rooms.map((room) => [room.id, 0]));
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
  const activeRoom = rooms.find((room) => room.id === activeRoomId);
  if (sidebarCurrentRoom) sidebarCurrentRoom.textContent = activeRoom ? activeRoom.name : '';
  for (const room of rooms) {
    const wrapper = document.createElement('div');
    wrapper.className = 'room-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `room-button${room.id === activeRoomId ? ' active' : ''}`;
    button.setAttribute('aria-label', `Комната: ${room.name}`);
    const hash = document.createElement('span');
    hash.className = 'room-hash';
    hash.textContent = '#';
    const label = document.createElement('span');
    label.className = 'room-label';
    label.textContent = room.name;
    button.append(hash, label);
    button.addEventListener('click', () => selectRoom(room.id));
    wrapper.append(button);
    const menuButton = document.createElement('button');
    menuButton.type = 'button';
    menuButton.className = 'room-menu-button';
    menuButton.textContent = '⋮';
    menuButton.setAttribute('aria-label', `Меню комнаты ${room.name}`);
    menuButton.addEventListener('click', (event) => { event.stopPropagation(); manageRoom(room); });
    wrapper.append(menuButton);
    roomList.append(wrapper);
  }
}

async function manageRoom(room) {
  const action = window.prompt(`Комната «${room.name}»: введи новое название для переименования или DELETE для удаления`);
  if (action === null) return;
  if (action.trim().toUpperCase() === 'DELETE') {
    if (!window.confirm(`Удалить комнату «${room.name}» и все её сообщения?`)) return;
    try {
      await api(`/api/rooms/${encodeURIComponent(room.id)}`, { method: 'DELETE' });
      rooms = rooms.filter((item) => item.id !== room.id);
      if (activeRoomId === room.id) await selectRoom(rooms[0].id);
      else renderRooms();
    } catch (error) { showToast(error.message); }
    return;
  }
  if (!action.trim()) return;
  try {
    const updated = await api(`/api/rooms/${encodeURIComponent(room.id)}`, { method: 'PUT', body: JSON.stringify({ name: action }) });
    rooms = rooms.map((item) => item.id === room.id ? updated : item);
    if (activeRoomId === room.id) {
      roomTitle.textContent = updated.name;
      if (sidebarCurrentRoom) sidebarCurrentRoom.textContent = updated.name;
    }
    renderRooms();
  } catch (error) { showToast(error.message); }
}

async function selectRoom(roomId) {
  activeRoomId = roomId;
  unreadCounts.set(roomId, 0);
  const room = rooms.find((item) => item.id === roomId);
  if (!room) return;
  roomTitle.textContent = room.name;
  if (sidebarCurrentRoom) sidebarCurrentRoom.textContent = room.name;
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
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'join', nickname, roomId, clientId }));
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
    if (activeRoomId) socket.send(JSON.stringify({ type: 'join', nickname, roomId: activeRoomId, clientId }));
  });
  socket.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
      if (['message', 'message:updated'].includes(data.type) && data.message) {
        if (data.message.roomId === activeRoomId) {
          removeEmptyState();
          if (data.type === 'message:updated') replaceRenderedMessage(data.message);
          else renderMessage(data.message);
          scrollToBottom();
        } else if (data.type === 'message' && data.message.roomId) {
          unreadCounts.set(data.message.roomId, (unreadCounts.get(data.message.roomId) || 0) + 1);
          renderRooms();
        }
    } else if (data.type === 'message:deleted' && data.roomId === activeRoomId) {
      messagesEl.querySelector(`[data-message-id="${Number(data.id)}"]`)?.remove();
      if (!messagesEl.querySelector('.message')) addEmptyState('Пока тихо. Напиши первым 👋');
    } else if (data.type === 'message:preview' && Number.isSafeInteger(Number(data.id))) {
      const article = messagesEl.querySelector(`[data-message-id="${Number(data.id)}"]`);
      if (article) renderPreview(data.preview, article.querySelector('.message-body'));
    } else if (data.type === 'room:created') {
      if (!rooms.some((room) => room.id === data.room?.id)) rooms.push(data.room);
      if (data.room?.id) unreadCounts.set(data.room.id, 0);
      renderRooms();
    } else if (data.type === 'room:updated') {
      rooms = rooms.map((room) => room.id === data.room?.id ? data.room : room);
      if (activeRoomId === data.room?.id) roomTitle.textContent = data.room.name;
      renderRooms();
    } else if (data.type === 'room:deleted') {
      rooms = rooms.filter((room) => room.id !== data.roomId);
      unreadCounts.delete(data.roomId);
      renderRooms();
      if (activeRoomId === data.roomId && rooms.length) void selectRoom(rooms[0].id);
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
  const safeMessage = message && typeof message === 'object' ? message : {};
  let article;
  try {
    article = buildMessageArticle(safeMessage);
  } catch (error) {
    console.error('Не удалось отобразить сообщение:', error);
    article = document.createElement('article');
    article.className = 'message';
    article.dataset.messageId = Number.isSafeInteger(Number(safeMessage.id)) ? String(safeMessage.id) : '';
    const fallback = document.createElement('p');
    fallback.className = 'message-render-error';
    fallback.textContent = 'Не удалось отобразить это сообщение.';
    article.append(fallback);
  }
  try {
    messagesEl.append(article);
  } catch (error) {
    console.error('Не удалось добавить сообщение в список:', error);
    return null;
  }
  return article;
}

function buildMessageArticle(safeMessage) {
  const article = document.createElement('article');
  article.className = 'message';
  article.dataset.messageId = String(safeMessage.id || '');
  article.dataset.authorId = typeof safeMessage.authorId === 'string' ? safeMessage.authorId : '';
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
  if (safeMessage.edited) {
    const edited = document.createElement('span'); edited.className = 'edited-marker'; edited.textContent = 'изменено'; meta.append(edited);
  }
  body.append(meta);
  if (typeof safeMessage.text === 'string' && safeMessage.text) {
    const text = document.createElement('p');
    text.className = 'message-text';
    linkifyText(text, safeMessage.text);
    body.append(text);
  }
  const firstTextUrl = typeof safeMessage.text === 'string' ? safeMessage.text.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.!?;:]+$/g, '') : '';
  try { if (safeMessage.preview || firstTextUrl) renderPreview(safeMessage.preview || {}, body, firstTextUrl); }
  catch (error) { console.error('Не удалось отобразить превью:', error); }
  try { renderAttachment(safeMessage.attachment, body); }
  catch (error) {
    console.error('Не удалось отобразить вложение:', error);
    try {
      const attachment = safeMessage.attachment;
      if (attachment && typeof attachment === 'object' && typeof attachment.url === 'string' && attachment.url.startsWith('/uploads/') && !attachment.url.includes('..')) {
        const fallback = document.createElement('a');
        fallback.className = 'attachment-file'; fallback.href = attachment.url; fallback.textContent = typeof attachment.originalName === 'string' ? attachment.originalName : (typeof attachment.name === 'string' ? attachment.name : 'Вложение');
        body.append(fallback);
      }
    } catch (fallbackError) { console.error('Не удалось отобразить резервное вложение:', fallbackError); }
  }
  article.append(avatar, body);
  try { if (safeMessage.authorId && safeMessage.authorId === clientId) addMessageActions(article, body, safeMessage); }
  catch (error) { console.error('Не удалось отобразить действия сообщения:', error); }
  return article;
}

function replaceRenderedMessage(message) {
  const old = messagesEl.querySelector(`[data-message-id="${Number(message.id)}"]`);
  if (!old) return;
  const next = document.createElement('div');
  messagesEl.append(next);
  renderMessage(message);
  const rendered = messagesEl.lastElementChild;
  next.remove();
  old.replaceWith(rendered);
}

function linkifyText(parent, value) {
  const escaped = document.createElement('span');
  escaped.textContent = String(value || '');
  const source = escaped.textContent;
  const safeAnchor = document.createElement('a');
  const content = document.createDocumentFragment();
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    let candidate = match[0];
    const trailing = candidate.match(/[),.!?;:]+$/)?.[0] || '';
    if (trailing) candidate = candidate.slice(0, -trailing.length);
    if (match.index > cursor) content.append(document.createTextNode(source.slice(cursor, match.index)));
    let safe = false;
    try { const parsed = new URL(candidate); safe = ['http:', 'https:'].includes(parsed.protocol); } catch {}
    if (candidate && safe) {
      const anchor = safeAnchor.cloneNode(false);
      anchor.href = candidate; anchor.target = '_blank'; anchor.rel = 'noopener'; anchor.textContent = candidate;
      content.append(anchor);
    } else content.append(document.createTextNode(candidate));
    if (trailing) content.append(document.createTextNode(trailing));
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) content.append(document.createTextNode(source.slice(cursor)));
  parent.replaceChildren(content);
}

function embedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl); const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(url.pathname.slice(1))}`;
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      const id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:embed|shorts)\/([^/?]+)/)?.[1];
      return id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` : '';
    }
    if (host === 'rutube.ru') { const id = url.pathname.match(/\/video\/([\w-]+)/)?.[1]; return id ? `https://rutube.ru/play/embed/${encodeURIComponent(id)}` : ''; }
    if (host === 'vk.com' || host === 'm.vk.com' || host === 'vkvideo.ru') {
      if (!/video/i.test(url.pathname)) return '';
      return `https://vk.com${url.pathname}${url.search}`;
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') { const id = url.pathname.match(/\/(?:video\/)?(\d+)/)?.[1]; return id ? `https://player.vimeo.com/video/${id}` : ''; }
  } catch {}
  return '';
}

function renderPreview(preview, parent, explicitUrl = '') {
  if (!preview || !parent || parent.querySelector('.link-preview') || parent.querySelector('.video-facade')) return;
  const firstUrl = explicitUrl || parent.closest('.message')?.querySelector('.message-text a')?.href;
  if (!firstUrl) return;
  const facadeUrl = embedUrl(firstUrl);
  if (facadeUrl) {
    const facade = document.createElement('button'); facade.type = 'button'; facade.className = 'video-facade'; facade.textContent = '▶ Нажми, чтобы загрузить видео';
    facade.addEventListener('click', () => {
      const frame = document.createElement('iframe'); frame.src = facadeUrl; frame.title = 'Видеоплеер'; frame.loading = 'lazy'; frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'; frame.allowFullscreen = true; facade.replaceWith(frame);
    }, { once: true });
    parent.append(facade); return;
  }
  const card = document.createElement('a'); card.className = 'link-preview'; card.href = firstUrl; card.target = '_blank'; card.rel = 'noopener';
  if (typeof preview.image === 'string' && /^https?:\/\//i.test(preview.image)) { const image = document.createElement('img'); image.src = preview.image; image.alt = ''; image.loading = 'lazy'; card.append(image); }
  const title = document.createElement('strong'); title.textContent = String(preview.title || firstUrl).slice(0, 240); card.append(title); parent.append(card);
}

function addMessageActions(article, body, message) {
  const wrap = document.createElement('div'); wrap.className = 'message-actions';
  const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Изменить'; edit.addEventListener('click', () => beginEdit(article, message));
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Удалить'; remove.addEventListener('click', async () => {
    if (!window.confirm('Удалить это сообщение?')) return;
    try { await api(`/api/messages/${message.id}`, { method: 'DELETE' }); article.remove(); } catch (error) { showToast(error.message); }
  });
  wrap.append(edit, remove); body.append(wrap);
}

function beginEdit(article, message) {
  if (article.querySelector('.edit-form')) return;
  const body = article.querySelector('.message-body'); const text = body.querySelector('.message-text');
  const form = document.createElement('form'); form.className = 'edit-form';
  const input = document.createElement('textarea'); input.maxLength = 2000; input.value = message.text || ''; input.setAttribute('aria-label', 'Изменить сообщение');
  const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Сохранить';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Отмена'; cancel.addEventListener('click', () => { form.remove(); if (text) text.classList.remove('hidden'); });
  form.addEventListener('submit', async (event) => { event.preventDefault(); if (!input.value.trim()) return showToast('Сообщение не может быть пустым.');
    try { const updated = await api(`/api/messages/${message.id}`, { method: 'PATCH', body: JSON.stringify({ text: input.value }) }); replaceRenderedMessage(updated); }
    catch (error) { showToast(error.message); }
  });
  if (text) text.classList.add('hidden'); form.append(input, save, cancel); body.append(form); input.focus();
}

function renderAttachment(attachment, parent) {
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return;
  const url = typeof attachment.url === 'string' && attachment.url.startsWith('/uploads/') && !attachment.url.includes('..') ? attachment.url : '';
  if (!url) return;
  const name = typeof attachment.originalName === 'string' && attachment.originalName ? attachment.originalName : (typeof attachment.name === 'string' && attachment.name ? attachment.name : 'Вложение');
  const type = typeof attachment.type === 'string' ? attachment.type.split(';', 1)[0].trim().toLowerCase() : '';
  const pathname = (() => { try { return new URL(url, window.location.origin).pathname.toLowerCase(); } catch { return url.toLowerCase(); } })();
  const isImage = type.startsWith('image/') || /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/.test(name.toLowerCase()) || /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/.test(pathname);
  const isPdf = type === 'application/pdf' || name.toLowerCase().endsWith('.pdf') || pathname.endsWith('.pdf');
  if (isImage) {
    const link = document.createElement('a');
    link.className = 'attachment-image-link';
    link.href = '#';
    link.addEventListener('click', (event) => { event.preventDefault(); openLightbox(url, name); });
    link.setAttribute('aria-label', `Открыть изображение ${name}`);
    const image = document.createElement('img');
    image.className = 'attachment-image';
    image.alt = name;
    image.loading = 'lazy';
    image.addEventListener('error', () => { link.replaceWith(createAttachmentFileLink(url, name, attachment.size)); }, { once: true });
    image.src = url;
    link.append(image);
    parent.append(link);
    return;
  }
  if (isPdf) {
    const card = document.createElement('div'); card.className = 'pdf-preview-card';
    const title = document.createElement('span'); title.className = 'attachment-name'; title.textContent = `📄 ${name}`;
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'pdf-load'; preview.textContent = 'Открыть предпросмотр';
    preview.addEventListener('click', () => { const frame = document.createElement('iframe'); frame.className = 'pdf-embed'; frame.src = url; frame.title = name; frame.loading = 'lazy'; preview.replaceWith(frame); }, { once: true });
    const open = document.createElement('a'); open.href = url; open.target = '_blank'; open.rel = 'noopener'; open.textContent = 'Открыть в новой вкладке';
    card.append(title, preview, open); parent.append(card); return;
  }
  const file = createAttachmentFileLink(url, name, attachment.size);
  file.href = url; file.target = '_blank'; file.rel = 'noopener';
  parent.append(file);
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

function openLightbox(src, name) {
  let overlay = document.querySelector('#lightbox');
  if (!overlay) {
    overlay = document.createElement('div'); overlay.id = 'lightbox'; overlay.className = 'lightbox'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    const image = document.createElement('img'); image.className = 'lightbox-image';
    overlay.append(image); overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });
    document.body.append(overlay);
  }
  const image = overlay.querySelector('img');
  image.src = src; image.alt = name; image.style.transform = 'scale(1)'; image.dataset.zoom = '1'; image.dataset.targetZoom = '1';
  if (image._zoomFrame) cancelAnimationFrame(image._zoomFrame);
  const close = (event) => { if (event.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', close); } };
  const animateZoom = () => {
    const current = Number(image.dataset.zoom || 1);
    const target = Number(image.dataset.targetZoom || 1);
    const next = current + (target - current) * 0.18;
    image.dataset.zoom = String(Math.abs(target - next) < 0.001 ? target : next);
    image.style.transform = `scale(${image.dataset.zoom})`;
    if (image.dataset.zoom !== image.dataset.targetZoom) image._zoomFrame = requestAnimationFrame(animateZoom);
    else image._zoomFrame = 0;
  };
  const zoom = (event) => {
    event.preventDefault();
    const current = Number(image.dataset.targetZoom || 1);
    const delta = Math.max(-240, Math.min(240, event.deltaY));
    const next = Math.max(.5, Math.min(4, current * Math.exp(-delta * 0.0018)));
    image.dataset.targetZoom = String(next);
    if (!image._zoomFrame) image._zoomFrame = requestAnimationFrame(animateZoom);
  };
  overlay.addEventListener('wheel', zoom, { passive: false });
  document.addEventListener('keydown', close);
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
  try { messagesEl.scrollTop = messagesEl.scrollHeight; }
  catch (error) { console.error('Не удалось прокрутить сообщения:', error); }
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
