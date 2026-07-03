/* ============================================================
   APOSENTO ALTO · Servidor de comunidad (Node puro, sin dependencias)
   - Sirve la app web (index.html) y una API REST simple
   - Cuentas, feed compartido, reacciones, seguir, mensajes privados,
     salas de estudio (presencia + chat de estudio en vivo)
   - Persistencia en data.json  ·  Puerto 4321
   Arrancar:  node server.js
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4321;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');

/* ---------- Almacenamiento ---------- */
// Si hay DATABASE_URL (Render/Postgres) los datos son permanentes de verdad.
// Si no (uso local con doble clic), se guardan en data.json como antes.
let db = { users: [], posts: [], follows: [], dms: [], rooms: [], sessions: {}, notifs: [] };
let rtcSignals = []; // señalización WebRTC (en memoria, no se guarda a disco)
let saveTimer = null;
let pgPool = null;

if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  } catch (e) { console.error('No se pudo cargar el módulo pg, usando data.json local:', e.message); }
}

async function loadState() {
  if (pgPool) {
    try {
      await pgPool.query('CREATE TABLE IF NOT EXISTS aposentoalto_state (id INT PRIMARY KEY, data JSONB)');
      const r = await pgPool.query('SELECT data FROM aposentoalto_state WHERE id = 1');
      if (r.rows.length) db = Object.assign(db, r.rows[0].data);
      else await pgPool.query('INSERT INTO aposentoalto_state (id, data) VALUES (1, $1)', [JSON.stringify(db)]);
      console.log('Conectado a PostgreSQL — datos permanentes ✅');
      return;
    } catch (e) { console.error('No se pudo conectar a PostgreSQL, usando data.json local:', e.message); }
  }
  try { if (fs.existsSync(DATA_FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { console.error('data.json corrupto, empezando limpio'); }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (pgPool) {
      try { await pgPool.query('UPDATE aposentoalto_state SET data = $1 WHERE id = 1', [JSON.stringify(db)]); return; }
      catch (e) { console.error('Error guardando en PostgreSQL:', e.message); }
    }
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error('No se pudo guardar', e); }
  }, 200);
}

/* ---------- Utilidades ---------- */
const uid = () => crypto.randomBytes(9).toString('hex');
function hash(pass, salt) { return crypto.createHash('sha256').update(salt + '|' + pass).digest('hex'); }
function publicUser(u) { return u ? { id: u.id, name: u.name, church: u.church, avatar: u.avatar, bio: u.bio || '', verse: u.verse || '' } : null; }
function userById(id) { return db.users.find(u => u.id === id); }
function userByToken(token) { const id = db.sessions[token]; return id ? userById(id) : null; }

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
  });
}

/* ---------- Enriquecer publicaciones para el cliente ---------- */
function enrichPost(p, meId) {
  const author = userById(p.userId);
  return {
    id: p.id, userId: p.userId,
    name: author ? author.name : 'Anónimo',
    church: author ? author.church : '',
    avatar: author ? author.avatar : '?',
    mine: meId && p.userId === meId,
    time: timeAgo(p.createdAt),
    body: p.body || '', verse: p.verse || null, event: p.event || null,
    reacts: p.reacts || { victoria: 0, viva: 0, uncion: 0, amen: 0 },
    myReact: meId ? (p.reactBy && p.reactBy[meId]) || null : null,
    following: meId ? isFollowing(meId, p.userId) : false,
    commentCount: (p.comments || []).length
  };
}
function isFollowing(a, b) { return db.follows.some(f => f.userId === a && f.targetId === b); }
function notify(toId, kind, fromId, extra) {
  if (!toId || toId === fromId) return;
  db.notifs.push(Object.assign({ id: uid(), toId, kind, fromId, ts: Date.now(), read: false }, extra || {}));
  if (db.notifs.length > 3000) db.notifs = db.notifs.slice(-2000);
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'ahora';
  const m = Math.floor(s / 60); if (m < 60) return 'hace ' + m + ' min';
  const h = Math.floor(m / 60); if (h < 24) return 'hace ' + h + ' h';
  const d = Math.floor(h / 24); return 'hace ' + d + ' d';
}

/* ---------- API ---------- */
async function handleApi(req, res, urlPath, query) {
  const token = req.headers['x-token'] || query.token || '';
  const me = userByToken(token);
  const body = (req.method === 'POST') ? await readBody(req) : {};
  const need = () => { if (!me) { send(res, 401, { error: 'Debes iniciar sesión' }); return false; } return true; };

  // --- Registro ---
  if (urlPath === '/api/register' && req.method === 'POST') {
    const name = (body.name || '').trim();
    const pass = (body.pass || '').trim();
    if (name.length < 2) return send(res, 400, { error: 'Escribe tu nombre' });
    if (pass.length < 4) return send(res, 400, { error: 'La contraseña debe tener al menos 4 caracteres' });
    if (db.users.some(u => u.name.toLowerCase() === name.toLowerCase())) return send(res, 400, { error: 'Ese nombre ya está registrado. Inicia sesión.' });
    const salt = crypto.randomBytes(6).toString('hex');
    const u = { id: uid(), name, church: (body.church || '').trim(), avatar: name.charAt(0).toUpperCase(), bio: '', verse: '', salt, hash: hash(pass, salt), createdAt: Date.now() };
    db.users.push(u);
    const t = crypto.randomBytes(16).toString('hex'); db.sessions[t] = u.id; save();
    return send(res, 200, { token: t, user: publicUser(u) });
  }

  // --- Login ---
  if (urlPath === '/api/login' && req.method === 'POST') {
    const name = (body.name || '').trim();
    const pass = (body.pass || '').trim();
    const u = db.users.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!u || u.hash !== hash(pass, u.salt)) return send(res, 400, { error: 'Nombre o contraseña incorrectos' });
    const t = crypto.randomBytes(16).toString('hex'); db.sessions[t] = u.id; save();
    return send(res, 200, { token: t, user: publicUser(u) });
  }

  // --- Yo ---
  if (urlPath === '/api/me') { if (!me) return send(res, 401, { error: 'no' }); return send(res, 200, { user: publicUser(me) }); }

  // --- Actualizar perfil ---
  if (urlPath === '/api/profile-update' && req.method === 'POST') {
    if (!need()) return;
    if (typeof body.church === 'string') me.church = body.church.trim();
    if (typeof body.bio === 'string') me.bio = body.bio.trim();
    if (typeof body.verse === 'string') me.verse = body.verse.trim();
    save(); return send(res, 200, { user: publicUser(me) });
  }

  // --- Feed ---
  if (urlPath === '/api/feed') {
    const posts = db.posts.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(p => enrichPost(p, me && me.id));
    return send(res, 200, { posts });
  }

  // --- Publicar ---
  if (urlPath === '/api/post' && req.method === 'POST') {
    if (!need()) return;
    const type = body.type || 'mensaje';
    const p = { id: uid(), userId: me.id, type, body: (body.body || '').slice(0, 2000), reacts: { victoria: 0, viva: 0, uncion: 0, amen: 0 }, reactBy: {}, createdAt: Date.now() };
    if (type === 'versiculo' && body.verse) p.verse = { text: String(body.verse.text || '').slice(0, 800), ref: String(body.verse.ref || '').slice(0, 120) };
    if (type === 'culto' && body.event) p.event = { day: body.event.day, month: body.event.month, title: String(body.event.title || '').slice(0, 160), sub: String(body.event.sub || '').slice(0, 200) };
    if (!p.body && !p.verse && !p.event) return send(res, 400, { error: 'Publicación vacía' });
    db.posts.push(p); save();
    return send(res, 200, { post: enrichPost(p, me.id) });
  }

  // --- Reaccionar ---
  if (urlPath === '/api/react' && req.method === 'POST') {
    if (!need()) return;
    const p = db.posts.find(x => x.id === body.postId); if (!p) return send(res, 404, { error: 'no existe' });
    p.reactBy = p.reactBy || {}; p.reacts = p.reacts || { victoria: 0, viva: 0, uncion: 0, amen: 0 };
    const prev = p.reactBy[me.id];
    const r = body.reaction;
    if (prev === r) { p.reacts[prev] = Math.max(0, (p.reacts[prev] || 0) - 1); delete p.reactBy[me.id]; }
    else { if (prev) p.reacts[prev] = Math.max(0, (p.reacts[prev] || 0) - 1); if (['victoria', 'viva', 'uncion', 'amen'].includes(r)) { p.reacts[r] = (p.reacts[r] || 0) + 1; p.reactBy[me.id] = r; notify(p.userId, 'react', me.id, { postId: p.id, reaction: r }); } }
    save(); return send(res, 200, { post: enrichPost(p, me.id) });
  }

  // --- Seguir ---
  if (urlPath === '/api/follow' && req.method === 'POST') {
    if (!need()) return;
    const target = body.targetId; if (!target || target === me.id) return send(res, 400, { error: 'no' });
    const i = db.follows.findIndex(f => f.userId === me.id && f.targetId === target);
    if (i >= 0) db.follows.splice(i, 1); else { db.follows.push({ userId: me.id, targetId: target }); notify(target, 'follow', me.id); }
    save(); return send(res, 200, { following: i < 0 });
  }

  // --- Perfil de alguien ---
  if (urlPath === '/api/profile') {
    const u = userById(query.id); if (!u) return send(res, 404, { error: 'no existe' });
    const posts = db.posts.filter(p => p.userId === u.id).sort((a, b) => b.createdAt - a.createdAt).map(p => enrichPost(p, me && me.id));
    return send(res, 200, {
      user: publicUser(u),
      posts,
      followers: db.follows.filter(f => f.targetId === u.id).length,
      following: db.follows.filter(f => f.userId === u.id).length,
      isFollowing: me ? isFollowing(me.id, u.id) : false,
      isMe: me && me.id === u.id
    });
  }

  // --- Lista de usuarios (para descubrir/escribir) ---
  if (urlPath === '/api/users') {
    const list = db.users.filter(u => !me || u.id !== me.id).map(u => ({ ...publicUser(u), followers: db.follows.filter(f => f.targetId === u.id).length }));
    return send(res, 200, { users: list });
  }

  // --- Mensajes: conversaciones ---
  if (urlPath === '/api/dm-list') {
    if (!need()) return;
    const partners = {};
    db.dms.filter(m => m.fromId === me.id || m.toId === me.id).forEach(m => {
      const other = m.fromId === me.id ? m.toId : m.fromId;
      if (!partners[other] || partners[other].ts < m.createdAt) partners[other] = { last: m.text, ts: m.createdAt };
    });
    const list = Object.keys(partners).map(id => ({ user: publicUser(userById(id)), last: partners[id].last, ts: partners[id].ts })).filter(x => x.user).sort((a, b) => b.ts - a.ts);
    return send(res, 200, { conversations: list });
  }

  // --- Mensajes con alguien ---
  if (urlPath === '/api/dm') {
    if (!need()) return;
    if (req.method === 'POST') {
      const to = body.to; const text = (body.text || '').trim().slice(0, 1000);
      if (!to || !text || !userById(to)) return send(res, 400, { error: 'no' });
      const m = { id: uid(), fromId: me.id, toId: to, text, createdAt: Date.now() };
      db.dms.push(m); notify(to, 'dm', me.id, { text: text.slice(0, 80) }); save(); return send(res, 200, { message: { me: true, text: m.text, ts: m.createdAt } });
    }
    const other = query.with;
    let changed = false;
    db.notifs.forEach(n => { if (n.toId === me.id && n.kind === 'dm' && n.fromId === other && !n.read) { n.read = true; changed = true; } });
    if (changed) save();
    const msgs = db.dms.filter(m => (m.fromId === me.id && m.toId === other) || (m.fromId === other && m.toId === me.id))
      .sort((a, b) => a.createdAt - b.createdAt).map(m => ({ me: m.fromId === me.id, text: m.text, ts: m.createdAt }));
    return send(res, 200, { messages: msgs, user: publicUser(userById(other)) });
  }

  // --- Salas de estudio ---
  if (urlPath === '/api/rooms') {
    pruneRooms();
    const list = db.rooms.map(r => ({ id: r.id, title: r.title, ref: r.ref || '', hostName: (userById(r.hostId) || {}).name || '—', host: ((userById(r.hostId) || {}).name || '—') + ' · anfitrión', live: true, mine: me && r.hostId === me.id, listeners: r.participants.length }));
    return send(res, 200, { rooms: list });
  }
  if (urlPath === '/api/room-create' && req.method === 'POST') {
    if (!need()) return;
    const title = (body.title || '').trim().slice(0, 160); if (!title) return send(res, 400, { error: 'Ponle un tema' });
    const r = { id: uid(), hostId: me.id, title, ref: (body.ref || '').trim().slice(0, 120), participants: [me.id], present: { [me.id]: Date.now() }, chat: [], speakers: [me.id], hands: {}, createdAt: Date.now() };
    db.rooms.push(r); save(); return send(res, 200, { id: r.id });
  }
  if (urlPath === '/api/room-join' && req.method === 'POST') {
    if (!need()) return; const r = db.rooms.find(x => x.id === body.id); if (!r) return send(res, 404, { error: 'La sala ya no existe' });
    if (!r.participants.includes(me.id)) r.participants.push(me.id);
    r.present = r.present || {}; r.present[me.id] = Date.now(); save(); return send(res, 200, { ok: true });
  }
  if (urlPath === '/api/room-leave' && req.method === 'POST') {
    if (!need()) return; const r = db.rooms.find(x => x.id === body.id); if (!r) return send(res, 200, { ok: true });
    r.participants = r.participants.filter(x => x !== me.id); if (r.present) delete r.present[me.id];
    if (r.speakers) r.speakers = r.speakers.filter(x => x !== me.id); if (r.hands) delete r.hands[me.id];
    if (r.hostId === me.id || r.participants.length === 0) db.rooms = db.rooms.filter(x => x.id !== r.id); // el anfitrión cierra la sala
    save(); return send(res, 200, { ok: true });
  }
  if (urlPath === '/api/room' && req.method === 'GET') {
    const r = db.rooms.find(x => x.id === query.id); if (!r) return send(res, 404, { error: 'La sala terminó' });
    if (me) { r.present = r.present || {}; r.present[me.id] = Date.now(); }
    pruneRoomPresence(r);
    r.speakers = r.speakers || [r.hostId]; r.hands = r.hands || {};
    const isSpk = id => id === r.hostId || r.speakers.includes(id);
    const parts = r.participants.map(id => ({ id, name: (userById(id) || {}).name || '—', host: id === r.hostId, speaker: isSpk(id), you: me && id === me.id })).filter(p => p.name !== '—');
    const hands = Object.keys(r.hands).map(id => ({ id, name: (userById(id) || {}).name || '—' })).filter(h => h.name !== '—');
    const myRole = !me ? 'guest' : (me.id === r.hostId ? 'host' : (r.speakers.includes(me.id) ? 'speaker' : 'listener'));
    return send(res, 200, { id: r.id, title: r.title, ref: r.ref, hostName: (userById(r.hostId) || {}).name || '—', participants: parts, chat: (r.chat || []).slice(-50), listeners: parts.length, isHost: me && r.hostId === me.id, hands, myRole, iRaised: me && !!r.hands[me.id] });
  }
  if (urlPath === '/api/room-hand' && req.method === 'POST') {
    if (!need()) return; const r = db.rooms.find(x => x.id === body.id); if (!r) return send(res, 404, { error: 'no' });
    r.hands = r.hands || {}; r.speakers = r.speakers || [r.hostId];
    if (r.hands[me.id]) delete r.hands[me.id];
    else if (!r.speakers.includes(me.id) && r.hostId !== me.id) r.hands[me.id] = Date.now();
    save(); return send(res, 200, { ok: true });
  }
  if (urlPath === '/api/room-grant' && req.method === 'POST') {
    if (!need()) return; const r = db.rooms.find(x => x.id === body.id); if (!r) return send(res, 404, { error: 'no' });
    if (r.hostId !== me.id) return send(res, 403, { error: 'Solo el anfitrión da la palabra' });
    const who = body.userId; r.speakers = r.speakers || [r.hostId]; if (!r.speakers.includes(who)) r.speakers.push(who);
    if (r.hands) delete r.hands[who];
    r.chat = r.chat || []; r.chat.push({ name: '', text: '🎤 ' + ((userById(who) || {}).name || 'Alguien') + ' recibió la palabra', ts: Date.now(), system: true });
    save(); return send(res, 200, { ok: true });
  }
  if (urlPath === '/api/room-mute' && req.method === 'POST') {
    if (!need()) return; const r = db.rooms.find(x => x.id === body.id); if (!r) return send(res, 404, { error: 'no' });
    const who = body.userId || me.id;
    if (who !== me.id && r.hostId !== me.id) return send(res, 403, { error: 'no' });
    if (who !== r.hostId && r.speakers) r.speakers = r.speakers.filter(x => x !== who);
    save(); return send(res, 200, { ok: true });
  }
  if (urlPath === '/api/room-say' && req.method === 'POST') {
    if (!need()) return; const r = db.rooms.find(x => x.id === body.id); if (!r) return send(res, 404, { error: 'no' });
    const text = (body.text || '').trim().slice(0, 500); if (!text) return send(res, 400, { error: 'vacío' });
    r.chat = r.chat || []; r.chat.push({ name: me.name, text, ts: Date.now(), host: r.hostId === me.id }); save();
    return send(res, 200, { ok: true });
  }

  // --- Señalización WebRTC (voz en vivo) ---
  if (urlPath === '/api/rtc' && req.method === 'POST') {
    if (!need()) return;
    if (body.room && body.to && body.data) {
      rtcSignals.push({ room: body.room, from: me.id, to: body.to, data: body.data, ts: Date.now() });
      if (rtcSignals.length > 5000) rtcSignals = rtcSignals.slice(-3000);
    }
    return send(res, 200, { ok: true });
  }
  if (urlPath === '/api/rtc' && req.method === 'GET') {
    if (!me) return send(res, 200, { peers: [], signals: [], speakers: [] });
    const r = db.rooms.find(x => x.id === query.room);
    if (!r) return send(res, 200, { peers: [], signals: [], speakers: [], ended: true });
    r.present = r.present || {}; r.present[me.id] = Date.now(); pruneRoomPresence(r);
    const mine = [], keep = [];
    for (const s of rtcSignals) { if (s.room === query.room && s.to === me.id) mine.push({ from: s.from, data: s.data }); else keep.push(s); }
    rtcSignals = keep;
    return send(res, 200, { peers: r.participants.filter(id => id !== me.id), signals: mine, speakers: r.speakers || [r.hostId] });
  }

  // --- Seguidores / Siguiendo ---
  if (urlPath === '/api/followers' || urlPath === '/api/following') {
    const id = query.id; if (!userById(id)) return send(res, 404, { error: 'no existe' });
    const ids = urlPath === '/api/followers'
      ? db.follows.filter(f => f.targetId === id).map(f => f.userId)
      : db.follows.filter(f => f.userId === id).map(f => f.targetId);
    const list = ids.map(uidx => publicUser(userById(uidx))).filter(Boolean).map(u => Object.assign(u, { iFollow: me ? isFollowing(me.id, u.id) : false, isMe: me && me.id === u.id }));
    return send(res, 200, { users: list });
  }

  // --- Quién reaccionó a una publicación ---
  if (urlPath === '/api/reactors') {
    const p = db.posts.find(x => x.id === query.postId); if (!p) return send(res, 404, { error: 'no existe' });
    const rb = p.reactBy || {};
    const emojis = { victoria: '🙌', viva: '👑', uncion: '🔥', amen: '🕊️' };
    const list = Object.keys(rb).map(uidx => { const u = publicUser(userById(uidx)); return u ? Object.assign(u, { reaction: rb[uidx], emoji: emojis[rb[uidx]] || '❤️', iFollow: me ? isFollowing(me.id, u.id) : false, isMe: me && me.id === u.id }) : null; }).filter(Boolean);
    return send(res, 200, { reactors: list });
  }

  // --- Comentarios ---
  if (urlPath === '/api/comment' && req.method === 'POST') {
    if (!need()) return;
    const p = db.posts.find(x => x.id === body.postId); if (!p) return send(res, 404, { error: 'no existe' });
    const text = (body.text || '').trim().slice(0, 800); if (!text) return send(res, 400, { error: 'vacío' });
    p.comments = p.comments || [];
    p.comments.push({ id: uid(), userId: me.id, text, ts: Date.now() });
    notify(p.userId, 'comment', me.id, { postId: p.id });
    save(); return send(res, 200, { ok: true });
  }
  if (urlPath === '/api/comments') {
    const p = db.posts.find(x => x.id === query.postId); if (!p) return send(res, 404, { error: 'no existe' });
    const list = (p.comments || []).map(c => { const u = userById(c.userId) || {}; return { id: c.id, userId: c.userId, name: u.name || 'Anónimo', avatar: u.avatar || '?', text: c.text, ago: timeAgo(c.ts) }; });
    return send(res, 200, { comments: list });
  }

  // --- Notificaciones ---
  if (urlPath === '/api/notifs') {
    if (!me) return send(res, 200, { items: [], unread: 0, unreadDm: 0 });
    const emojis = { victoria: '🙌', viva: '👑', uncion: '🔥', amen: '🕊️' };
    const mine = db.notifs.filter(n => n.toId === me.id).sort((a, b) => b.ts - a.ts).slice(0, 60);
    const items = mine.map(n => {
      const from = userById(n.fromId) || { name: 'Alguien', avatar: '?', id: '' };
      let text = '';
      if (n.kind === 'follow') text = 'comenzó a seguirte';
      else if (n.kind === 'react') text = 'reaccionó ' + (emojis[n.reaction] || '') + ' a tu publicación';
      else if (n.kind === 'dm') text = 'te envió un mensaje';
      else if (n.kind === 'comment') text = 'comentó tu publicación';
      return { id: n.id, kind: n.kind, fromId: n.fromId, fromName: from.name, avatar: from.avatar, text, ts: n.ts, ago: timeAgo(n.ts), read: n.read };
    });
    return send(res, 200, { items, unread: mine.filter(n => !n.read && n.kind !== 'dm').length + mine.filter(n => !n.read && n.kind === 'dm').length, unreadDm: db.notifs.filter(n => n.toId === me.id && n.kind === 'dm' && !n.read).length });
  }
  if (urlPath === '/api/notifs-read' && req.method === 'POST') {
    if (!need()) return;
    db.notifs.forEach(n => { if (n.toId === me.id) { if (!body.scope || body.scope === 'all') n.read = true; else if (body.scope === 'nondm' && n.kind !== 'dm') n.read = true; } });
    save(); return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Ruta no encontrada' });
}

/* Limpieza: quita salas sin actividad y participantes ausentes */
function pruneRoomPresence(r) {
  const now = Date.now(); r.present = r.present || {};
  r.participants = r.participants.filter(id => (r.present[id] || 0) > now - 30000);
  if (r.speakers) r.speakers = r.speakers.filter(id => r.participants.includes(id));
  if (r.hands) Object.keys(r.hands).forEach(id => { if (!r.participants.includes(id)) delete r.hands[id]; });
}
function pruneRooms() {
  const now = Date.now();
  db.rooms.forEach(pruneRoomPresence);
  // se cierra si el anfitrión se fue o queda vacía
  db.rooms = db.rooms.filter(r => r.participants.includes(r.hostId) && r.createdAt > now - 1000 * 60 * 60 * 12);
}

/* ---------- Archivos estáticos ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(ROOT, decodeURIComponent(p));
  if (!file.startsWith(ROOT) || file === DATA_FILE) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------- Servidor ---------- */
(async () => {
  await loadState();
  http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const urlPath = u.pathname;
    const query = Object.fromEntries(u.searchParams);
    try {
      if (urlPath.startsWith('/api/')) return await handleApi(req, res, urlPath, query);
      serveStatic(req, res, urlPath);
    } catch (e) { console.error(e); send(res, 500, { error: 'Error del servidor' }); }
  }).listen(PORT, () => {
    console.log('====================================================');
    console.log('  APOSENTO ALTO en vivo  ·  http://localhost:' + PORT);
    console.log('  Comunidad lista. Abre ese link en tu navegador.');
    console.log('====================================================');
  });
})();
