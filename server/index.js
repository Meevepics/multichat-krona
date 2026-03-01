// ============================================================
//  MEEVE MULTICHAT SERVER v2 — MASTERCHAT EDITION
//  ✅ YouTube via masterchat — SIN API KEY, SIN CUOTA
//  ✅ VideoId manual via /api/youtube/video-id o YOUTUBE_VIDEO_ID env
//  ✅ Auto-reconexión cuando termina el live
// ============================================================

const express    = require('express');
const http       = require('http');
const https      = require('https');
const { WebSocketServer } = require('ws');
const tmi        = require('tmi.js');

let WebcastPushConnection;
try {
  ({ WebcastPushConnection } = require('tiktok-live-connector'));
} catch(e) { console.log('[TikTok] tiktok-live-connector no disponible'); }

let Masterchat, stringify_mc;
try {
  ({ Masterchat, stringify: stringify_mc } = require('masterchat'));
} catch(e) { console.log('[YouTube] ⚠️  masterchat no instalado — corré: npm i masterchat'); }

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ── CONFIG ───────────────────────────────────────────────────
const CONFIG = {
  twitch:           process.env.TWITCH_CHANNEL      || '',
  kick:             process.env.KICK_CHANNEL        || '',
  kickId:           process.env.KICK_CHANNEL_ID     || '',
  tiktok:           process.env.TIKTOK_USERNAME     || '',
  youtubeHandle:    (process.env.YOUTUBE_HANDLE     || '').trim(),
  youtubeChannelId: (process.env.YOUTUBE_CHANNEL_ID || '').trim(),
  // ✅ YOUTUBE_VIDEO_ID: pegá el ID del video cuando arrancás el live
  //    ej: si el link es https://youtube.com/watch?v=abc123xyz  → YOUTUBE_VIDEO_ID=abc123xyz
  youtubeVideoId:   (process.env.YOUTUBE_VIDEO_ID   || '').trim(),
  port:             process.env.PORT                || 3000,
  tiktokMode:       process.env.TIKTOK_MODE         || 'connector',
};

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── ESTADO ───────────────────────────────────────────────────
const state = {
  clients:  new Set(),
  tiktok:   { connected: false, lastMsg: 0, instance: null, restartCount: 0 },
  twitch:   { connected: false },
  kick:     { connected: false },
  youtube:  {
    connected:  false,
    videoId:    CONFIG.youtubeVideoId || null,
    mcInstance: null,
    retryTimer: null,
  },
  msgCount: 0,
};

// ══════════════════════════════════════════════════════════════
// ★ Parsear emotes de Twitch
// ══════════════════════════════════════════════════════════════
function parseTwitchEmotes(message, emotesTag) {
  if (!emotesTag || typeof emotesTag !== 'object') return [];
  const result = [];
  for (const [emoteId, positions] of Object.entries(emotesTag)) {
    for (const pos of positions) {
      const [start, end] = pos.split('-').map(Number);
      result.push({ text: message.slice(start, end + 1), url: `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/1.0`, start, end });
    }
  }
  return result.sort((a, b) => a.start - b.start);
}

// ── AVATAR CACHES ────────────────────────────────────────────
const kickAvatarCache = {}, kickAvatarPending = {};
const twitchAvatarCache = {}, twitchAvatarPending = {};

function getTwitchAvatar(username, callback) {
  if (!username) return callback(null);
  const slug = username.toLowerCase();
  if (twitchAvatarCache[slug]) return callback(twitchAvatarCache[slug]);
  if (twitchAvatarPending[slug]) { twitchAvatarPending[slug].push(callback); return; }
  twitchAvatarPending[slug] = [callback];
  const req = https.get(`https://decapi.me/twitch/avatar/${slug}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
    let body = ''; res.on('data', c => body += c);
    res.on('end', () => {
      const avatar = body.trim().startsWith('http') ? body.trim() : null;
      if (avatar) twitchAvatarCache[slug] = avatar;
      const cbs = twitchAvatarPending[slug] || []; delete twitchAvatarPending[slug];
      cbs.forEach(cb => cb(avatar));
    });
  });
  req.on('error', () => { const cbs = twitchAvatarPending[slug] || []; delete twitchAvatarPending[slug]; cbs.forEach(cb => cb(null)); });
  req.setTimeout(5000, () => req.destroy());
}

function getKickAvatar(username, callback) {
  if (!username) return callback(null);
  const slug = username.toLowerCase();
  if (kickAvatarCache[slug]) return callback(kickAvatarCache[slug]);
  if (kickAvatarPending[slug]) { kickAvatarPending[slug].push(callback); return; }
  kickAvatarPending[slug] = [callback];
  const req = https.get(`https://kick.com/api/v2/channels/${slug}`, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
    let body = ''; res.on('data', c => body += c);
    res.on('end', () => {
      let avatar = null;
      try { const d = JSON.parse(body); avatar = (d.user && (d.user.profile_pic || d.user.profilePic)) || d.profile_pic || null; } catch(e) {}
      if (avatar) kickAvatarCache[slug] = avatar;
      const cbs = kickAvatarPending[slug] || []; delete kickAvatarPending[slug];
      cbs.forEach(cb => cb(avatar));
    });
  });
  req.on('error', () => { const cbs = kickAvatarPending[slug] || []; delete kickAvatarPending[slug]; cbs.forEach(cb => cb(null)); });
  req.setTimeout(8000, () => req.destroy());
}

// ── BROADCAST ────────────────────────────────────────────────
function broadcast(msg) {
  const raw = JSON.stringify(msg);
  state.clients.forEach(ws => { if (ws.readyState === 1) ws.send(raw); });
  state.msgCount++;
}

function broadcastStatus() {
  broadcast({
    type: 'status',
    twitch: state.twitch.connected, kick: state.kick.connected,
    tiktok: state.tiktok.connected, youtube: state.youtube.connected,
    youtubeVideoId: state.youtube.videoId || null,
    tiktokMode: CONFIG.tiktokMode,
    channels: { twitch: CONFIG.twitch, kick: CONFIG.kick, tiktok: CONFIG.tiktok, youtube: CONFIG.youtubeHandle || CONFIG.youtubeChannelId }
  });
}

// ── WEBSOCKET CLIENTS ────────────────────────────────────────
wss.on('connection', (ws) => {
  state.clients.add(ws);
  ws.send(JSON.stringify({
    type: 'status',
    twitch: state.twitch.connected, kick: state.kick.connected,
    tiktok: state.tiktok.connected, youtube: state.youtube.connected,
    youtubeVideoId: state.youtube.videoId || null,
    tiktokMode: CONFIG.tiktokMode,
    channels: { twitch: CONFIG.twitch, kick: CONFIG.kick, tiktok: CONFIG.tiktok, youtube: CONFIG.youtubeHandle || CONFIG.youtubeChannelId }
  }));
  ws.on('close', () => state.clients.delete(ws));
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'custom_message') broadcast({ type: 'custom', platform: 'custom', chatname: msg.user || 'Tú', chatmessage: msg.text, nameColor: '#FF6B9D', mid: 'custom-' + Date.now() });
      if (msg.type === 'highlight') broadcast({ type: 'highlight', platform: msg.platform || 'custom', chatname: msg.chatname || '', chatmessage: msg.chatmessage || '', chatimg: msg.chatimg || null, nameColor: msg.nameColor || '#FF6B9D', roles: msg.roles || [], chatemotes: msg.chatemotes || [], mid: msg.mid || ('hl-' + Date.now()) });
      if (msg.type === 'highlight_clear') broadcast({ type: 'highlight_clear' });
      if (msg.type === 'kick_message')      handleKickMessageFromBrowser(msg);
      if (msg.type === 'kick_donation')     handleKickDonationFromBrowser(msg);
      if (msg.type === 'kick_disconnected') { state.kick.connected = false; broadcastStatus(); }
      if (msg.type === 'kick_connected')    { state.kick.connected = true;  broadcastStatus(); }
      // ✅ Permitir setear videoId de YouTube desde el frontend via WebSocket
      if (msg.type === 'youtube_set_video') {
        const vid = extractVideoId(msg.videoId || msg.url || '');
        if (vid) { state.youtube.videoId = vid; connectYouTube(); }
      }
    } catch(e) {}
  });
});

// ══════════════════════════════════════════════════════════════
//  TWITCH IRC + DONACIONES
// ══════════════════════════════════════════════════════════════
function connectTwitch() {
  if (!CONFIG.twitch) return;
  const client = new tmi.Client({ options: { debug: false }, channels: [CONFIG.twitch] });
  client.connect().catch(() => setTimeout(connectTwitch, 10000));
  client.on('connected',    () => { state.twitch.connected = true;  broadcastStatus(); });
  client.on('disconnected', () => { state.twitch.connected = false; broadcastStatus(); setTimeout(connectTwitch, 5000); });
  client.on('message', (channel, tags, message, self) => {
    if (self) return;
    const badges = tags.badges || {}, roles = [];
    if (badges.broadcaster) roles.push({ type: 'broadcaster', label: 'Streamer' });
    if (badges.moderator)   roles.push({ type: 'moderator',   label: 'Mod' });
    if (badges.vip)         roles.push({ type: 'vip',         label: 'VIP' });
    if (badges.subscriber)  roles.push({ type: 'subscriber',  label: 'Sub' });
    if (badges.founder)     roles.push({ type: 'founder',     label: 'Founder' });
    const chatemotes = parseTwitchEmotes(message, tags.emotes);
    const bitsMatch  = message.match(/cheer(\d+)/i);
    const bitsAmount = tags.bits ? parseInt(tags.bits) : (bitsMatch ? parseInt(bitsMatch[1]) : 0);
    const twitchUser = tags['display-name'] || tags.username || '';
    getTwitchAvatar(twitchUser, (avatar) => {
      if (bitsAmount > 0) {
        broadcast({ type: 'donation', platform: 'twitch', donationType: 'bits', chatname: twitchUser, chatmessage: message.replace(/cheer\d+\s*/gi, '').trim() || `¡${bitsAmount} Bits!`, chatemotes, amount: bitsAmount, currency: 'BITS', nameColor: tags.color || '#9146FF', chatimg: avatar || null, roles, mid: 'tw-bits-' + Date.now() });
      } else {
        broadcast({ type: 'twitch', platform: 'twitch', chatname: twitchUser, chatmessage: message, chatemotes, nameColor: tags.color || '#9146FF', chatimg: avatar || null, roles, mid: tags.id || ('tw-' + Date.now()) });
      }
    });
  });
  client.on('subscription',   (ch, u, method, msg, us) => broadcast({ type: 'donation', platform: 'twitch', donationType: 'sub',     chatname: us['display-name'] || u, chatmessage: msg || '¡Nuevo suscriptor!',            subPlan: method?.plan || 'Prime', nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-sub-'     + Date.now() }));
  client.on('resub',          (ch, u, months, msg, us, methods) => broadcast({ type: 'donation', platform: 'twitch', donationType: 'resub',   chatname: us['display-name'] || u, chatmessage: msg || `¡${months} meses!`,            months, subPlan: methods?.plan || 'Prime', nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-resub-'   + Date.now() }));
  client.on('subgift',        (ch, u, s, recipient, methods, us) => broadcast({ type: 'donation', platform: 'twitch', donationType: 'subgift', chatname: us['display-name'] || u, chatmessage: `¡Regaló una sub a ${recipient}!`, recipient, subPlan: methods?.plan || '1000', nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-gift-'    + Date.now() }));
  client.on('submysterygift', (ch, u, num, methods, us) => broadcast({ type: 'donation', platform: 'twitch', donationType: 'subgift', chatname: us['display-name'] || u, chatmessage: `¡Regaló ${num} subs!`,               amount: num,                            nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-massgift-' + Date.now() }));
}

// ══════════════════════════════════════════════════════════════
//  KICK
// ══════════════════════════════════════════════════════════════
app.get('/api/kick/channel-id', (req, res) => res.json({ kickId: CONFIG.kickId || null, channel: CONFIG.kick }));
app.post('/api/kick/channel-id', (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId requerido' });
  CONFIG.kickId = String(channelId); res.json({ ok: true, kickId: CONFIG.kickId });
});
function handleKickMessageFromBrowser(data) {
  if (!data.chatname && !data.chatmessage) return;
  const username = data.chatname || 'Unknown';
  if (data.chatimg) broadcast({ type: 'kick', platform: 'kick', chatname: username, chatmessage: data.chatmessage, nameColor: data.nameColor || '#53FC18', chatimg: data.chatimg, roles: data.roles || [], chatemotes: data.chatemotes || [], mid: data.mid || ('kick-' + Date.now()) });
  else getKickAvatar(username, (avatar) => broadcast({ type: 'kick', platform: 'kick', chatname: username, chatmessage: data.chatmessage, nameColor: data.nameColor || '#53FC18', chatimg: avatar || null, roles: data.roles || [], chatemotes: data.chatemotes || [], mid: data.mid || ('kick-' + Date.now()) }));
}
function handleKickDonationFromBrowser(data) {
  getKickAvatar(data.chatname || 'Unknown', (avatar) => broadcast({ type: 'donation', platform: 'kick', donationType: data.donationType || 'giftedsub', chatname: data.chatname || 'Unknown', chatmessage: data.chatmessage || '', amount: data.amount || null, currency: data.currency || null, months: data.months || null, nameColor: data.nameColor || '#53FC18', chatimg: avatar || null, roles: data.roles || [], mid: data.mid || ('kick-don-' + Date.now()) }));
}

// ── KICK Pusher ──────────────────────────────────────────────
const { WebSocket: NodeWS } = require('ws');
const PUSHER_URLS = [
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false',
  'wss://ws-us2.pusher.com/app/eb1d5f283081a78b932c?protocol=7&client=js&version=7.6.0&flash=false',
];
let kickPusherWs = null, kickRetryDelay = 5000, kickRetryTimeout = null, kickUrlIndex = 0, kickPingInterval = null;

async function resolveKickChannelId(channelName) {
  return new Promise((resolve) => {
    const req = https.get(`https://kick.com/api/v2/channels/${channelName.toLowerCase()}`, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { const d = JSON.parse(body); resolve(String((d.chatroom && d.chatroom.id) || d.id || '') || null); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}
async function connectKick() {
  if (!CONFIG.kick) return;
  if (!CONFIG.kickId) {
    const id = await resolveKickChannelId(CONFIG.kick);
    if (!id) { kickRetryTimeout = setTimeout(connectKick, 60000); return; }
    CONFIG.kickId = id; console.log(`[Kick] ✅ Chatroom ID: ${CONFIG.kickId}`);
  }
  tryKickPusher(CONFIG.kickId);
}
function tryKickPusher(channelId) {
  if (kickPusherWs) { try { kickPusherWs.terminate(); } catch(e) {} kickPusherWs = null; }
  if (kickPingInterval) { clearInterval(kickPingInterval); kickPingInterval = null; }
  const url = PUSHER_URLS[kickUrlIndex % PUSHER_URLS.length];
  let ws; try { ws = new NodeWS(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); } catch(e) { kickRetryTimeout = setTimeout(() => { kickUrlIndex++; tryKickPusher(channelId); }, kickRetryDelay); return; }
  kickPusherWs = ws;
  ws.on('open', () => {
    kickRetryDelay = 5000;
    ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${channelId}.v2` } }));
    kickPingInterval = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); }, 25000);
  });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch(e) { return; }
    const event = msg.event || '';
    if (event === 'pusher:connection_established' || event === 'pusher:pong') return;
    if (event === 'pusher_internal:subscription_succeeded') { console.log(`[Kick] ✅ Conectado chatroom ${channelId}`); state.kick.connected = true; broadcastStatus(); return; }
    if (event === 'pusher:error') { ws.terminate(); return; }
    let d; try { d = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data; } catch(e) { return; }
    if (!d) return;
    if (event === 'App\\Events\\ChatMessageEvent' || event === 'App.Events.ChatMessageEvent') {
      const sender = d.sender || {}, username = sender.username || 'KickUser', content = d.content || '';
      const badges = (sender.identity && sender.identity.badges) || [], nameColor = (sender.identity && sender.identity.color) || '#53FC18';
      const kickRoles = [];
      badges.forEach(b => { const bt = (b.type || '').toLowerCase(); if (bt === 'broadcaster' || bt === 'owner') kickRoles.push({ type: 'broadcaster', label: 'Owner' }); else if (bt === 'moderator' || bt === 'mod') kickRoles.push({ type: 'moderator', label: 'Mod' }); else if (bt === 'vip') kickRoles.push({ type: 'vip', label: 'VIP' }); else if (bt === 'subscriber' || bt === 'sub') kickRoles.push({ type: 'subscriber', label: 'Sub' }); else kickRoles.push({ type: bt, label: b.type }); });
      getKickAvatar(username, (avatar) => broadcast({ type: 'kick', platform: 'kick', chatname: username, chatmessage: content, nameColor, chatimg: avatar || null, roles: kickRoles, mid: d.id || ('kick-' + Date.now()) }));
    }
    if (event === 'App\\Events\\GiftedSubscriptionsEvent' || event === 'App.Events.GiftedSubscriptionsEvent') { const gifter = (d.gifted_by && d.gifted_by.username) || 'Anónimo', qty = (d.gifted_usernames && d.gifted_usernames.length) || 1; getKickAvatar(gifter, (avatar) => broadcast({ type: 'donation', platform: 'kick', donationType: 'giftedsub', chatname: gifter, chatmessage: `¡Regaló ${qty} sub(s)!`, amount: qty, chatimg: avatar || null, nameColor: '#53FC18', roles: [], mid: 'kick-gift-' + Date.now() })); }
    if (event === 'App\\Events\\SubscriptionEvent' || event === 'App.Events.SubscriptionEvent') { const username = (d.user_ids && d.usernames && d.usernames[0]) || d.username || 'KickUser'; getKickAvatar(username, (avatar) => broadcast({ type: 'donation', platform: 'kick', donationType: 'sub', chatname: username, chatmessage: '¡Se suscribió!', chatimg: avatar || null, nameColor: '#53FC18', roles: [], mid: 'kick-sub-' + Date.now() })); }
  });
  ws.on('close', () => { if (kickPingInterval) { clearInterval(kickPingInterval); kickPingInterval = null; } state.kick.connected = false; broadcastStatus(); kickUrlIndex++; kickRetryDelay = Math.min(kickRetryDelay * 1.5, 60000); kickRetryTimeout = setTimeout(() => tryKickPusher(channelId), kickRetryDelay); });
  ws.on('error', (e) => console.error('[Kick] WS error:', e.message));
}

// ══════════════════════════════════════════════════════════════
//  TIKTOK
// ══════════════════════════════════════════════════════════════
async function connectTikTokConnector() {
  if (!CONFIG.tiktok || !WebcastPushConnection) return;
  const username = CONFIG.tiktok.startsWith('@') ? CONFIG.tiktok : '@' + CONFIG.tiktok;
  if (state.tiktok.instance) { try { state.tiktok.instance.disconnect(); } catch(e) {} state.tiktok.instance = null; }
  const conn = new WebcastPushConnection(username, { processInitialData: false, enableExtendedGiftInfo: true, enableWebsocketUpgrade: true, requestPollingIntervalMs: 2000, sessionId: process.env.TIKTOK_SESSION_ID || undefined });
  state.tiktok.instance = conn;
  try { await conn.connect(); state.tiktok.connected = true; state.tiktok.lastMsg = Date.now(); broadcastStatus(); }
  catch(e) { broadcastStatus(); setTimeout(() => connectTikTokConnector(), e.message?.includes('LIVE_NOT_FOUND') ? 60000 : e.message?.includes('403') ? 300000 : 15000); return; }
  conn.on('chat', (data) => { state.tiktok.lastMsg = Date.now(); broadcast({ type: 'tiktok', platform: 'tiktok', chatname: data.uniqueId || data.nickname || 'TikToker', chatmessage: data.comment, chatimg: data.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-' + Date.now() + '-' + Math.random() }); });
  conn.on('gift', (data) => { state.tiktok.lastMsg = Date.now(); if (data.giftType === 1 && !data.repeatEnd) return; const gn = data.giftName || data.extendedGiftInfo?.name || `Gift #${data.giftId}`, di = data.diamondCount || 0, qty = data.repeatCount || 1; broadcast({ type: 'donation', platform: 'tiktok', donationType: 'gift', chatname: data.uniqueId || 'TikToker', chatmessage: `¡Envió ${qty}x ${gn}! (${di * qty} 💎)`, giftName: gn, amount: di * qty, currency: 'DIAMONDS', quantity: qty, chatimg: data.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-gift-' + Date.now() }); });
  conn.on('subscribe', (data) => broadcast({ type: 'donation', platform: 'tiktok', donationType: 'sub', chatname: data.uniqueId || 'TikToker', chatmessage: '¡Se suscribió!', chatimg: data.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-sub-' + Date.now() }));
  conn.on('disconnected', () => { state.tiktok.connected = false; broadcastStatus(); setTimeout(() => connectTikTokConnector(), 10000); });
  conn.on('error', (e) => console.error('[TikTok] Error:', e?.message || e));
}
setInterval(() => { if (state.tiktok.connected && state.tiktok.lastMsg > 0 && Date.now() - state.tiktok.lastMsg > 3 * 60 * 1000) { state.tiktok.connected = false; broadcastStatus(); connectTikTokConnector(); } }, 60000);

// ══════════════════════════════════════════════════════════════
//  YOUTUBE — via masterchat (SIN API KEY, SIN CUOTA)
// ══════════════════════════════════════════════════════════════

// ✅ Extrae el videoId desde una URL de YouTube o un ID directo
function extractVideoId(input) {
  if (!input) return null;
  input = input.trim();
  // Si ya es un videoId (11 chars alfanuméricos)
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  // Extrae de URLs: youtube.com/watch?v=XXX, youtu.be/XXX, etc.
  const m = input.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function connectYouTube() {
  if (!Masterchat) {
    console.log('[YouTube] ❌ masterchat no instalado. Agregá "masterchat" al package.json');
    return;
  }

  // Limpiar instancia anterior
  if (state.youtube.mcInstance) {
    try { state.youtube.mcInstance.stop(); } catch(e) {}
    state.youtube.mcInstance = null;
  }
  if (state.youtube.retryTimer) { clearTimeout(state.youtube.retryTimer); state.youtube.retryTimer = null; }

  const videoId = state.youtube.videoId;
  if (!videoId) {
    console.log('[YouTube] ⏳ Sin videoId. Usá el panel de control o define YOUTUBE_VIDEO_ID para conectar.');
    state.youtube.connected = false;
    broadcastStatus();
    return;
  }

  console.log(`[YouTube] 🔄 Conectando a https://youtube.com/watch?v=${videoId} (sin API key)...`);

  try {
    const mc = await Masterchat.init(videoId, '', { mode: 'live' });
    state.youtube.mcInstance = mc;

    mc.on('chat', (action) => {
      if (action.type !== 'addChatItemAction') return;
      const item = action.item;
      if (!item) return;

      const authorName  = item.authorName || 'YouTuber';
      const authorPhoto = item.authorPhoto?.url || null;
      const roles = [];
      if (item.isOwner)     roles.push({ type: 'broadcaster', label: 'Streamer' });
      if (item.isModerator) roles.push({ type: 'moderator',   label: 'Mod' });
      if (item.membership)  roles.push({ type: 'member',      label: 'Miembro' });

      const getText = (msg) => {
        if (!msg) return '';
        if (stringify_mc) return stringify_mc(msg);
        return Array.isArray(msg) ? msg.map(r => r.text || '').join('') : '';
      };

      if (!item.superchat && !item.isMembership) {
        const text = getText(item.message);
        if (!text) return;
        broadcast({ type: 'youtube', platform: 'youtube', chatname: authorName, chatmessage: text, chatimg: authorPhoto, nameColor: '#FF0000', roles, mid: 'yt-' + (item.id || Date.now()) });
      }

      if (item.superchat) {
        const sc = item.superchat;
        broadcast({ type: 'donation', platform: 'youtube', donationType: 'superchat', chatname: authorName, chatmessage: getText(item.message) || '¡Super Chat!', chatimg: authorPhoto, nameColor: '#FF0000', amount: sc.amount || 0, amountDisplay: sc.displayString || String(sc.amount || ''), currency: sc.currency || 'USD', roles, mid: 'yt-sc-' + (item.id || Date.now()) });
      }

      if (item.isMembership) {
        broadcast({ type: 'donation', platform: 'youtube', donationType: 'member', chatname: authorName, chatmessage: getText(item.message) || '¡Nuevo miembro!', chatimg: authorPhoto, nameColor: '#FF0000', roles, mid: 'yt-mem-' + (item.id || Date.now()) });
      }
    });

    mc.on('end', (reason) => {
      console.log(`[YouTube] 🔴 Live terminado: ${reason || 'desconocido'}`);
      state.youtube.connected  = false;
      state.youtube.videoId    = CONFIG.youtubeVideoId || null;
      state.youtube.mcInstance = null;
      broadcastStatus();
    });

    mc.on('error', (err) => {
      console.error('[YouTube] ❌ Error masterchat:', err?.message || err);
    });

    mc.listen();
    state.youtube.connected = true;
    console.log(`[YouTube] ✅ Conectado al chat sin API key 🎉`);
    broadcastStatus();

  } catch(err) {
    console.error('[YouTube] ❌ Error conectando:', err?.message || err);
    state.youtube.connected  = false;
    state.youtube.mcInstance = null;
    broadcastStatus();
  }
}

// ── HTTP ENDPOINTS ───────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  ok: true, uptime: Math.floor(process.uptime()), messages: state.msgCount,
  clients: state.clients.size, twitch: state.twitch.connected, kick: state.kick.connected,
  kickChatroomId: CONFIG.kickId || null, tiktok: state.tiktok.connected,
  youtube: state.youtube.connected, youtubeVideoId: state.youtube.videoId || null,
}));

app.get('/tiktok-preview', (req, res) => {
  const user = CONFIG.tiktok || req.query.user || '';
  res.send(`<!DOCTYPE html><html><body style="background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;flex-direction:column;gap:20px"><div style="font-size:60px">🎵</div><h2>TikTok no permite embeds</h2>${user?`<a href="https://www.tiktok.com/@${user}/live" style="background:#FF0050;color:#fff;padding:12px 28px;border-radius:999px;text-decoration:none;font-weight:700">🔴 Ver @${user} en vivo</a>`:''}</body></html>`);
});

app.post('/api/tiktok/restart', (req, res) => { state.tiktok.connected = false; state.tiktok.restartCount++; broadcastStatus(); connectTikTokConnector(); res.json({ ok: true, restarts: state.tiktok.restartCount }); });
app.post('/api/kick/restart',   (req, res) => { if (kickRetryTimeout) { clearTimeout(kickRetryTimeout); kickRetryTimeout = null; } state.kick.connected = false; CONFIG.kickId = process.env.KICK_CHANNEL_ID || ''; broadcastStatus(); connectKick(); res.json({ ok: true }); });

// ✅ ENDPOINT PRINCIPAL: pegar URL o videoId del live de YouTube
app.post('/api/youtube/connect', (req, res) => {
  const input = req.body.url || req.body.videoId || '';
  const videoId = extractVideoId(input);
  if (!videoId) return res.status(400).json({ error: 'URL o videoId inválido. Ejemplo: https://youtube.com/watch?v=abc123xyz' });
  state.youtube.videoId = videoId;
  connectYouTube();
  res.json({ ok: true, videoId });
});

// Alias para compatibilidad con versiones anteriores
app.post('/api/youtube/video-id', (req, res) => {
  const input = req.body.videoId || req.body.url || '';
  const videoId = extractVideoId(input);
  if (!videoId) return res.status(400).json({ error: 'videoId inválido' });
  state.youtube.videoId = videoId;
  connectYouTube();
  res.json({ ok: true, videoId });
});

app.post('/api/youtube/restart', (req, res) => {
  const input = (req.body && (req.body.videoId || req.body.url)) || '';
  const videoId = extractVideoId(input);
  if (videoId) state.youtube.videoId = videoId;
  else state.youtube.videoId = CONFIG.youtubeVideoId || null;
  connectYouTube();
  res.json({ ok: true, videoId: state.youtube.videoId });
});

app.get('/api/status', (req, res) => res.json({
  twitch:  { connected: state.twitch.connected,  channel: CONFIG.twitch },
  kick:    { connected: state.kick.connected,    channel: CONFIG.kick },
  tiktok:  { connected: state.tiktok.connected,  user: CONFIG.tiktok },
  youtube: { connected: state.youtube.connected, videoId: state.youtube.videoId, handle: CONFIG.youtubeHandle || CONFIG.youtubeChannelId },
  clients: state.clients.size, messages: state.msgCount, uptime: Math.floor(process.uptime()),
}));

// ── ARRANCAR ─────────────────────────────────────────────────
server.listen(CONFIG.port, () => {
  console.log(`\n🎮 MEEVE MULTICHAT SERVER v2 — MASTERCHAT EDITION`);
  console.log(`   Puerto         : ${CONFIG.port}`);
  console.log(`   Twitch         : ${CONFIG.twitch || '(no config)'}`);
  console.log(`   Kick           : ${CONFIG.kick   || '(no config)'}`);
  console.log(`   TikTok         : ${CONFIG.tiktok || '(no config)'}`);
  console.log(`   YouTube handle : ${CONFIG.youtubeHandle || CONFIG.youtubeChannelId || '(no config)'}`);
  console.log(`   YouTube videoId: ${CONFIG.youtubeVideoId || '(pegar desde el panel cuando arranques el live)'}`);
  console.log(`   ⚡ YouTube mode : masterchat — SIN API KEY, SIN CUOTA\n`);
  if (CONFIG.youtubeVideoId) console.log(`[YouTube] 🎯 VideoId hardcodeado, conectando...`);
  else console.log(`[YouTube] ℹ️  Para conectar: POST /api/youtube/connect con { "url": "https://youtube.com/watch?v=XXXX" }`);
  connectTwitch();
  connectKick();
  connectTikTokConnector();
  connectYouTube();
});
