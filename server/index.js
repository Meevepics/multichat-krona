// ============================================================
//  MEEVE MULTICHAT SERVER v2 — FIXED
//  ✅ Chat: Twitch + Kick + TikTok + YouTube
//  ✅ Donaciones: Twitch Bits/Subs | TikTok Gifts | Kick (browser) | YouTube SuperChats
//  ✅ Kick avatar resuelto via kick.com/api/v2
//  ✅ FIXED: Twitch emotes → chatemotes [{text,url,start,end}]
//  ✅ FIXED: YOUTUBE_CHANNEL_ID directo — evita gastar cuota en resolución
//  ✅ FIXED: Backoff agresivo en error de cuota YouTube (403/429)
// ============================================================

const express    = require('express');
const http       = require('http');
const https      = require('https');
const { WebSocketServer } = require('ws');
const tmi        = require('tmi.js');

let WebcastPushConnection;
try {
  ({ WebcastPushConnection } = require('tiktok-live-connector'));
} catch(e) {
  console.log('[TikTok] tiktok-live-connector no disponible');
}

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ── CONFIG ───────────────────────────────────────────────────
const CONFIG = {
  twitch:          process.env.TWITCH_CHANNEL      || '',
  kick:            process.env.KICK_CHANNEL        || '',
  kickId:          process.env.KICK_CHANNEL_ID     || '',
  tiktok:          process.env.TIKTOK_USERNAME     || '',
  youtubeHandle:   process.env.YOUTUBE_HANDLE      || '',
  youtubeKey:      process.env.YOUTUBE_API_KEY     || '',
  // ✅ NUEVO: si defines YOUTUBE_CHANNEL_ID en Render, se usa directo y no gasta cuota
  youtubeChannelId: process.env.YOUTUBE_CHANNEL_ID || '',
  port:            process.env.PORT                || 3000,
  tiktokMode:      process.env.TIKTOK_MODE         || 'connector',
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
  youtube:  { connected: false, channelId: CONFIG.youtubeChannelId || null, liveChatId: null, nextPageToken: null, pollTimer: null },
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
      const text = message.slice(start, end + 1);
      result.push({
        text,
        url: `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/1.0`,
        start,
        end,
      });
    }
  }
  result.sort((a, b) => a.start - b.start);
  return result;
}

// ══════════════════════════════════════════════════════════════
// KICK AVATAR CACHE
// ══════════════════════════════════════════════════════════════
const kickAvatarCache   = {};
const kickAvatarPending = {};

// ── TWITCH AVATAR CACHE ──────────────────────────────────────
const twitchAvatarCache   = {};
const twitchAvatarPending = {};

function getTwitchAvatar(username, callback) {
  if (!username) return callback(null);
  const slug = username.toLowerCase();
  if (twitchAvatarCache[slug])   return callback(twitchAvatarCache[slug]);
  if (twitchAvatarPending[slug]) { twitchAvatarPending[slug].push(callback); return; }
  twitchAvatarPending[slug] = [callback];
  const url = `https://decapi.me/twitch/avatar/${slug}`;
  const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      const avatar = body.trim().startsWith('http') ? body.trim() : null;
      if (avatar) twitchAvatarCache[slug] = avatar;
      const cbs = twitchAvatarPending[slug] || [];
      delete twitchAvatarPending[slug];
      cbs.forEach(cb => cb(avatar));
    });
  });
  req.on('error', () => {
    const cbs = twitchAvatarPending[slug] || [];
    delete twitchAvatarPending[slug];
    cbs.forEach(cb => cb(null));
  });
  req.setTimeout(5000, () => { req.destroy(); });
}

function getKickAvatar(username, callback) {
  if (!username) return callback(null);
  const slug = username.toLowerCase();
  if (kickAvatarCache[slug])   return callback(kickAvatarCache[slug]);
  if (kickAvatarPending[slug]) { kickAvatarPending[slug].push(callback); return; }
  kickAvatarPending[slug] = [callback];
  const url = `https://kick.com/api/v2/channels/${slug}`;
  const req = https.get(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    }
  }, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      let avatar = null;
      try {
        const data = JSON.parse(body);
        avatar = (data.user && (data.user.profile_pic || data.user.profilePic)) || data.profile_pic || null;
      } catch(e) {}
      if (avatar) kickAvatarCache[slug] = avatar;
      const cbs = kickAvatarPending[slug] || [];
      delete kickAvatarPending[slug];
      cbs.forEach(cb => cb(avatar));
    });
  });
  req.on('error', () => {
    const cbs = kickAvatarPending[slug] || [];
    delete kickAvatarPending[slug];
    cbs.forEach(cb => cb(null));
  });
  req.setTimeout(8000, () => { req.destroy(); });
}

// ── BROADCAST ────────────────────────────────────────────────
function broadcast(msg) {
  const raw = JSON.stringify(msg);
  state.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(raw);
  });
  state.msgCount++;
}

function broadcastStatus() {
  broadcast({
    type:    'status',
    twitch:  state.twitch.connected,
    kick:    state.kick.connected,
    tiktok:  state.tiktok.connected,
    youtube: state.youtube.connected,
    tiktokMode: CONFIG.tiktokMode,
    channels: {
      twitch:  CONFIG.twitch,
      kick:    CONFIG.kick,
      tiktok:  CONFIG.tiktok,
      youtube: CONFIG.youtubeHandle,
    }
  });
}

// ── WEBSOCKET CLIENTS ────────────────────────────────────────
wss.on('connection', (ws) => {
  state.clients.add(ws);
  ws.send(JSON.stringify({
    type: 'status',
    twitch:  state.twitch.connected,
    kick:    state.kick.connected,
    tiktok:  state.tiktok.connected,
    youtube: state.youtube.connected,
    tiktokMode: CONFIG.tiktokMode,
    channels: { twitch: CONFIG.twitch, kick: CONFIG.kick, tiktok: CONFIG.tiktok, youtube: CONFIG.youtubeHandle }
  }));

  ws.on('close', () => { state.clients.delete(ws); });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'custom_message') {
        broadcast({ type: 'custom', platform: 'custom', chatname: msg.user || 'Tú', chatmessage: msg.text, nameColor: '#FF6B9D', mid: 'custom-' + Date.now() });
      }

      if (msg.type === 'highlight') {
        broadcast({
          type: 'highlight', platform: msg.platform || 'custom',
          chatname: msg.chatname || '', chatmessage: msg.chatmessage || '',
          chatimg: msg.chatimg || null, nameColor: msg.nameColor || '#FF6B9D',
          roles: msg.roles || [], chatemotes: msg.chatemotes || [],
          mid: msg.mid || ('hl-' + Date.now()),
        });
      }

      if (msg.type === 'highlight_clear') broadcast({ type: 'highlight_clear' });

      if (msg.type === 'kick_message')      handleKickMessageFromBrowser(msg);
      if (msg.type === 'kick_donation')     handleKickDonationFromBrowser(msg);
      if (msg.type === 'kick_disconnected') { state.kick.connected = false; broadcastStatus(); }
      if (msg.type === 'kick_connected')    { state.kick.connected = true;  broadcastStatus(); }
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

  client.on('connected', () => {
    state.twitch.connected = true;
    broadcastStatus();
  });

  client.on('disconnected', () => {
    state.twitch.connected = false;
    broadcastStatus();
    setTimeout(connectTwitch, 5000);
  });

  client.on('message', (channel, tags, message, self) => {
    if (self) return;

    const badges = tags.badges || {};
    const roles = [];
    if (badges.broadcaster) roles.push({ type: 'broadcaster', label: 'Streamer' });
    if (badges.moderator)   roles.push({ type: 'moderator',   label: 'Mod' });
    if (badges.vip)         roles.push({ type: 'vip',         label: 'VIP' });
    if (badges.subscriber)  roles.push({ type: 'subscriber',  label: 'Sub' });
    if (badges.founder)     roles.push({ type: 'founder',     label: 'Founder' });

    const chatemotes = parseTwitchEmotes(message, tags.emotes);

    const bitsMatch = message.match(/cheer(\d+)/i);
    const bitsAmount = tags.bits ? parseInt(tags.bits) : (bitsMatch ? parseInt(bitsMatch[1]) : 0);
    const twitchUser = tags['display-name'] || tags.username || '';

    getTwitchAvatar(twitchUser, (avatar) => {
      if (bitsAmount > 0) {
        broadcast({
          type: 'donation', platform: 'twitch', donationType: 'bits',
          chatname: twitchUser,
          chatmessage: message.replace(/cheer\d+\s*/gi, '').trim() || `¡${bitsAmount} Bits!`,
          chatemotes,
          amount: bitsAmount, currency: 'BITS',
          nameColor: tags.color || '#9146FF',
          chatimg: avatar || null, roles,
          mid: 'tw-bits-' + Date.now(),
        });
      } else {
        broadcast({
          type: 'twitch', platform: 'twitch',
          chatname: twitchUser,
          chatmessage: message,
          chatemotes,
          nameColor: tags.color || '#9146FF',
          chatimg: avatar || null, roles,
          mid: tags.id || ('tw-' + Date.now()),
        });
      }
    });
  });

  client.on('subscription', (channel, username, method, message, userstate) => {
    broadcast({ type: 'donation', platform: 'twitch', donationType: 'sub', chatname: userstate['display-name'] || username, chatmessage: message || '¡Nuevo suscriptor!', subPlan: method?.plan || 'Prime', nameColor: userstate?.color || '#9146FF', chatimg: null, mid: 'tw-sub-' + Date.now() });
  });

  client.on('resub', (channel, username, months, message, userstate, methods) => {
    broadcast({ type: 'donation', platform: 'twitch', donationType: 'resub', chatname: userstate['display-name'] || username, chatmessage: message || `¡${months} meses de sub!`, months, subPlan: methods?.plan || 'Prime', nameColor: userstate?.color || '#9146FF', chatimg: null, mid: 'tw-resub-' + Date.now() });
  });

  client.on('subgift', (channel, username, streakMonths, recipient, methods, userstate) => {
    broadcast({ type: 'donation', platform: 'twitch', donationType: 'subgift', chatname: userstate['display-name'] || username, chatmessage: `¡Regaló una sub a ${recipient}!`, recipient, subPlan: methods?.plan || '1000', nameColor: userstate?.color || '#9146FF', chatimg: null, mid: 'tw-gift-' + Date.now() });
  });

  client.on('submysterygift', (channel, username, numSubsGifted, methods, userstate) => {
    broadcast({ type: 'donation', platform: 'twitch', donationType: 'subgift', chatname: userstate['display-name'] || username, chatmessage: `¡Regaló ${numSubsGifted} subs!`, amount: numSubsGifted, nameColor: userstate?.color || '#9146FF', chatimg: null, mid: 'tw-massgift-' + Date.now() });
  });
}

// ══════════════════════════════════════════════════════════════
//  KICK
// ══════════════════════════════════════════════════════════════
app.get('/api/kick/channel-id', (req, res) => res.json({ kickId: CONFIG.kickId || null, channel: CONFIG.kick }));

app.post('/api/kick/channel-id', (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId requerido' });
  CONFIG.kickId = String(channelId);
  res.json({ ok: true, kickId: CONFIG.kickId });
});

function handleKickMessageFromBrowser(data) {
  if (!data.chatname && !data.chatmessage) return;
  const username = data.chatname || 'Unknown';
  if (data.chatimg) {
    broadcast({ type: 'kick', platform: 'kick', chatname: username, chatmessage: data.chatmessage, nameColor: data.nameColor || '#53FC18', chatimg: data.chatimg, roles: data.roles || [], chatemotes: data.chatemotes || [], mid: data.mid || ('kick-' + Date.now()) });
  } else {
    getKickAvatar(username, (avatar) => {
      broadcast({ type: 'kick', platform: 'kick', chatname: username, chatmessage: data.chatmessage, nameColor: data.nameColor || '#53FC18', chatimg: avatar || null, roles: data.roles || [], chatemotes: data.chatemotes || [], mid: data.mid || ('kick-' + Date.now()) });
    });
  }
}

function handleKickDonationFromBrowser(data) {
  const username = data.chatname || 'Unknown';
  getKickAvatar(username, (avatar) => {
    broadcast({ type: 'donation', platform: 'kick', donationType: data.donationType || 'giftedsub', chatname: username, chatmessage: data.chatmessage || '', amount: data.amount || null, currency: data.currency || null, months: data.months || null, nameColor: data.nameColor || '#53FC18', chatimg: avatar || null, roles: data.roles || [], mid: data.mid || ('kick-don-' + Date.now()) });
  });
}

// ══════════════════════════════════════════════════════════════
//  KICK — Conexión directa desde el servidor via Pusher WebSocket
// ══════════════════════════════════════════════════════════════
const { WebSocket: NodeWS } = require('ws');

const PUSHER_URLS = [
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false',
  'wss://ws-us2.pusher.com/app/eb1d5f283081a78b932c?protocol=7&client=js&version=7.6.0&flash=false',
];

let kickPusherWs     = null;
let kickRetryDelay   = 5000;
let kickRetryTimeout = null;
let kickUrlIndex     = 0;
let kickPingInterval = null;

async function resolveKickChannelId(channelName) {
  return new Promise((resolve) => {
    const url = `https://kick.com/api/v2/channels/${channelName.toLowerCase()}`;
    const req = https.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const id = String((data.chatroom && data.chatroom.id) || data.id || '');
          resolve(id || null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}

async function connectKick() {
  if (!CONFIG.kick) return;

  if (!CONFIG.kickId) {
    console.log(`[Kick] Resolviendo chatroom ID para canal: ${CONFIG.kick}`);
    const id = await resolveKickChannelId(CONFIG.kick);
    if (!id) {
      console.log('[Kick] ❌ No se pudo resolver el chatroom ID. Reintentando en 60s...');
      kickRetryTimeout = setTimeout(connectKick, 60000);
      return;
    }
    CONFIG.kickId = id;
    console.log(`[Kick] ✅ Chatroom ID resuelto: ${CONFIG.kickId}`);
  }

  tryKickPusher(CONFIG.kickId);
}

function tryKickPusher(channelId) {
  if (kickPusherWs) {
    try { kickPusherWs.terminate(); } catch(e) {}
    kickPusherWs = null;
  }
  if (kickPingInterval) { clearInterval(kickPingInterval); kickPingInterval = null; }

  const url = PUSHER_URLS[kickUrlIndex % PUSHER_URLS.length];
  console.log(`[Kick] Conectando a Pusher (chatroom ${channelId})...`);

  let ws;
  try {
    ws = new NodeWS(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
  } catch(e) {
    console.error('[Kick] Error creando WS:', e.message);
    kickRetryTimeout = setTimeout(() => { kickUrlIndex++; tryKickPusher(channelId); }, kickRetryDelay);
    return;
  }

  kickPusherWs = ws;

  ws.on('open', () => {
    kickRetryDelay = 5000;
    ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${channelId}.v2` } }));
    kickPingInterval = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
    }, 25000);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    const event = msg.event || '';

    if (event === 'pusher:connection_established' || event === 'pusher:pong') return;

    if (event === 'pusher_internal:subscription_succeeded') {
      console.log(`[Kick] ✅ Conectado al chatroom ${channelId}`);
      state.kick.connected = true;
      broadcastStatus();
      return;
    }

    if (event === 'pusher:error') {
      console.error('[Kick] Error de Pusher:', msg.data);
      ws.terminate();
      return;
    }

    let d;
    try { d = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data; } catch(e) { return; }
    if (!d) return;

    if (event === 'App\\Events\\ChatMessageEvent' || event === 'App.Events.ChatMessageEvent') {
      const sender    = d.sender || {};
      const username  = sender.username || d.chatname || 'KickUser';
      const content   = d.content || '';
      const badges    = (sender.identity && sender.identity.badges) || [];
      const nameColor = (sender.identity && sender.identity.color) || '#53FC18';

      const kickRoles = [];
      badges.forEach(b => {
        const bt = (b.type || '').toLowerCase();
        if (bt === 'broadcaster' || bt === 'owner') kickRoles.push({ type: 'broadcaster', label: 'Owner' });
        else if (bt === 'moderator' || bt === 'mod') kickRoles.push({ type: 'moderator', label: 'Mod' });
        else if (bt === 'vip') kickRoles.push({ type: 'vip', label: 'VIP' });
        else if (bt === 'subscriber' || bt === 'sub') kickRoles.push({ type: 'subscriber', label: 'Sub' });
        else kickRoles.push({ type: bt, label: b.type });
      });

      getKickAvatar(username, (avatar) => {
        broadcast({
          type: 'kick', platform: 'kick',
          chatname: username, chatmessage: content,
          nameColor, chatimg: avatar || null,
          roles: kickRoles,
          mid: d.id || ('kick-' + Date.now()),
        });
      });
    }

    if (event === 'App\\Events\\GiftedSubscriptionsEvent' || event === 'App.Events.GiftedSubscriptionsEvent') {
      const gifter = (d.gifted_by && d.gifted_by.username) || 'Anónimo';
      const qty = (d.gifted_usernames && d.gifted_usernames.length) || 1;
      getKickAvatar(gifter, (avatar) => {
        broadcast({ type: 'donation', platform: 'kick', donationType: 'giftedsub', chatname: gifter, chatmessage: `¡Regaló ${qty} sub(s)!`, amount: qty, chatimg: avatar || null, nameColor: '#53FC18', roles: [], mid: 'kick-gift-' + Date.now() });
      });
    }

    if (event === 'App\\Events\\SubscriptionEvent' || event === 'App.Events.SubscriptionEvent') {
      const username = (d.user_ids && d.usernames && d.usernames[0]) || d.username || 'KickUser';
      getKickAvatar(username, (avatar) => {
        broadcast({ type: 'donation', platform: 'kick', donationType: 'sub', chatname: username, chatmessage: '¡Se suscribió!', chatimg: avatar || null, nameColor: '#53FC18', roles: [], mid: 'kick-sub-' + Date.now() });
      });
    }
  });

  ws.on('close', (code) => {
    console.log(`[Kick] Desconectado (code ${code}). Reintentando en ${kickRetryDelay / 1000}s...`);
    if (kickPingInterval) { clearInterval(kickPingInterval); kickPingInterval = null; }
    state.kick.connected = false;
    broadcastStatus();
    kickUrlIndex++;
    kickRetryDelay = Math.min(kickRetryDelay * 1.5, 60000);
    kickRetryTimeout = setTimeout(() => tryKickPusher(channelId), kickRetryDelay);
  });

  ws.on('error', (e) => {
    console.error('[Kick] WS error:', e.message);
  });
}

// ══════════════════════════════════════════════════════════════
//  TIKTOK
// ══════════════════════════════════════════════════════════════
async function connectTikTokConnector() {
  if (!CONFIG.tiktok) return;
  if (!WebcastPushConnection) return;

  const username = CONFIG.tiktok.startsWith('@') ? CONFIG.tiktok : '@' + CONFIG.tiktok;

  if (state.tiktok.instance) {
    try { state.tiktok.instance.disconnect(); } catch(e) {}
    state.tiktok.instance = null;
  }

  const conn = new WebcastPushConnection(username, {
    processInitialData: false, enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true, requestPollingIntervalMs: 2000,
    sessionId: process.env.TIKTOK_SESSION_ID || undefined,
  });

  state.tiktok.instance = conn;

  try {
    await conn.connect();
    state.tiktok.connected = true;
    state.tiktok.lastMsg   = Date.now();
    broadcastStatus();
  } catch(e) {
    broadcastStatus();
    const delay = e.message?.includes('LIVE_NOT_FOUND') ? 60000 : e.message?.includes('403') ? 300000 : 15000;
    setTimeout(() => connectTikTokConnector(), delay);
    return;
  }

  conn.on('chat', (data) => {
    state.tiktok.lastMsg = Date.now();
    broadcast({ type: 'tiktok', platform: 'tiktok', chatname: data.uniqueId || data.nickname || 'TikToker', chatmessage: data.comment, chatimg: data.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-' + Date.now() + '-' + Math.random() });
  });

  conn.on('gift', (data) => {
    state.tiktok.lastMsg = Date.now();
    if (data.giftType === 1 && !data.repeatEnd) return;
    const giftName = data.giftName || data.extendedGiftInfo?.name || `Gift #${data.giftId}`;
    const diamonds = data.diamondCount || 0;
    const quantity = data.repeatCount || 1;
    broadcast({ type: 'donation', platform: 'tiktok', donationType: 'gift', chatname: data.uniqueId || 'TikToker', chatmessage: `¡Envió ${quantity}x ${giftName}! (${diamonds * quantity} 💎)`, giftName, amount: diamonds * quantity, currency: 'DIAMONDS', quantity, chatimg: data.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-gift-' + Date.now() });
  });

  conn.on('subscribe', (data) => {
    broadcast({ type: 'donation', platform: 'tiktok', donationType: 'sub', chatname: data.uniqueId || 'TikToker', chatmessage: '¡Se suscribió al canal!', chatimg: data.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-sub-' + Date.now() });
  });

  conn.on('disconnected', () => {
    state.tiktok.connected = false;
    broadcastStatus();
    setTimeout(() => connectTikTokConnector(), 10000);
  });

  conn.on('error', (e) => console.error('[TikTok] Error:', e?.message || e));
}

setInterval(() => {
  if (state.tiktok.connected && state.tiktok.lastMsg > 0 && Date.now() - state.tiktok.lastMsg > 3 * 60 * 1000) {
    state.tiktok.connected = false;
    broadcastStatus();
    connectTikTokConnector();
  }
}, 60000);

// ══════════════════════════════════════════════════════════════
//  YOUTUBE
// ══════════════════════════════════════════════════════════════
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ✅ NUEVO: solo resuelve si no hay YOUTUBE_CHANNEL_ID ya hardcodeado
async function youtubeResolveChannelId(handleOrName) {
  // Si ya tenemos el channelId directo, usarlo sin hacer requests
  if (CONFIG.youtubeChannelId) {
    console.log('[YouTube] ✅ Usando YOUTUBE_CHANNEL_ID directo (sin consumir cuota):', CONFIG.youtubeChannelId);
    return CONFIG.youtubeChannelId;
  }

  if (!handleOrName || !CONFIG.youtubeKey) {
    console.log('[YouTube] ❌ Faltan datos: handle=' + handleOrName + ' key=' + (CONFIG.youtubeKey ? 'OK' : 'MISSING'));
    return null;
  }
  if (/^UC[\w-]{22}$/.test(handleOrName)) {
    console.log('[YouTube] Handle es un channelId directo:', handleOrName);
    return handleOrName;
  }
  const query = handleOrName.replace(/^@/, '');
  console.log('[YouTube] Buscando channelId para handle:', query);
  try {
    const handleData = await fetchJSON(
      `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${encodeURIComponent(query)}&key=${CONFIG.youtubeKey}`
    );
    console.log('[YouTube] Respuesta forHandle:', JSON.stringify(handleData).slice(0, 300));
    if (handleData.items?.length > 0) {
      console.log('[YouTube] ✅ ChannelId encontrado vía forHandle:', handleData.items[0].id);
      return handleData.items[0].id;
    }
    console.log('[YouTube] No encontrado vía forHandle, probando search...');
    const searchData = await fetchJSON(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=channel&maxResults=5&key=${CONFIG.youtubeKey}`
    );
    if (searchData.items?.length > 0) {
      const id = searchData.items[0].snippet?.channelId;
      console.log('[YouTube] ✅ ChannelId encontrado vía search:', id);
      return id;
    }
    console.log('[YouTube] ❌ No se encontró channelId para:', query);
    return null;
  } catch(e) {
    console.error('[YouTube] ❌ Error resolviendo channelId:', e.message);
    return null;
  }
}

async function youtubeGetLiveChatId(channelId) {
  if (!channelId || !CONFIG.youtubeKey) return null;
  console.log('[YouTube] Buscando live activo para channelId:', channelId);
  try {
    const searchData = await fetchJSON(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=live&type=video&key=${CONFIG.youtubeKey}`
    );
    console.log('[YouTube] Respuesta búsqueda live:', JSON.stringify(searchData).slice(0, 300));
    if (!searchData.items?.length) {
      console.log('[YouTube] ⏳ No hay live activo en este momento.');
      return null;
    }
    const videoId = searchData.items[0].id?.videoId;
    console.log('[YouTube] Video en vivo encontrado:', videoId);
    if (!videoId) return null;
    const videoData = await fetchJSON(
      `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${CONFIG.youtubeKey}`
    );
    const chatId = videoData.items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
    console.log('[YouTube] liveChatId:', chatId || '❌ No encontrado');
    return chatId;
  } catch(e) {
    console.error('[YouTube] ❌ Error buscando live:', e.message);
    return null;
  }
}

async function youtubePollChat() {
  if (!state.youtube.liveChatId || !CONFIG.youtubeKey) return;
  let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${state.youtube.liveChatId}&part=snippet,authorDetails&maxResults=200&key=${CONFIG.youtubeKey}`;
  if (state.youtube.nextPageToken) url += `&pageToken=${encodeURIComponent(state.youtube.nextPageToken)}`;

  try {
    const data = await fetchJSON(url);
    if (data.error) {
      const code = data.error.code;
      console.error('[YouTube] ❌ Error en poll:', code, data.error.message);

      // ✅ NUEVO: backoff agresivo si es error de cuota (403 rateLimitExceeded o 429)
      if (code === 429 || (code === 403 && data.error.message?.toLowerCase().includes('quota'))) {
        console.log('[YouTube] ⚠️ Cuota agotada. Pausando YouTube por 6 horas para no desperdiciar más cuota.');
        clearTimeout(state.youtube.pollTimer);
        state.youtube.connected = false;
        broadcastStatus();
        // Reintentar en 6 horas — la cuota se resetea a medianoche PT
        setTimeout(connectYouTube, 6 * 60 * 60 * 1000);
        return;
      }

      if (code === 403 || code === 404) {
        clearTimeout(state.youtube.pollTimer);
        state.youtube.connected = false; state.youtube.liveChatId = null;
        broadcastStatus();
        console.log('[YouTube] Live terminado o sin permisos. Reintentando en 5 min...');
        setTimeout(connectYouTube, 5 * 60 * 1000);
      }
      return;
    }
    state.youtube.nextPageToken = data.nextPageToken || state.youtube.nextPageToken;

    for (const item of (data.items || [])) {
      const snippet       = item.snippet || {};
      const authorDetails = item.authorDetails || {};
      const msgType       = snippet.type;
      const base = {
        chatname: authorDetails.displayName || 'YouTuber',
        chatimg:  authorDetails.profileImageUrl || null,
        nameColor: '#FF0000',
        isOwner:  authorDetails.isChatOwner     || false,
        isMod:    authorDetails.isChatModerator || false,
        isMember: authorDetails.isChatSponsor   || false,
      };
      const roles = [];
      if (base.isOwner)  roles.push({ type: 'broadcaster', label: 'Streamer' });
      if (base.isMod)    roles.push({ type: 'moderator',   label: 'Mod' });
      if (base.isMember) roles.push({ type: 'member',      label: 'Miembro' });

      if (msgType === 'textMessageEvent') {
        broadcast({ type: 'youtube', platform: 'youtube', ...base, chatmessage: snippet.displayMessage || snippet.textMessageDetails?.messageText || '', roles, mid: 'yt-' + item.id });
      } else if (msgType === 'superChatEvent') {
        const sc = snippet.superChatDetails || {};
        broadcast({ type: 'donation', platform: 'youtube', donationType: 'superchat', ...base, chatmessage: sc.userComment || '¡Super Chat!', amount: sc.amountMicros ? sc.amountMicros / 1000000 : 0, amountDisplay: sc.amountDisplayString || '', currency: sc.currency || 'USD', tier: sc.tier || 1, roles, mid: 'yt-sc-' + item.id });
      } else if (msgType === 'newSponsorEvent' || msgType === 'memberMilestoneChatEvent') {
        broadcast({ type: 'donation', platform: 'youtube', donationType: 'member', ...base, chatmessage: snippet.displayMessage || '¡Nuevo miembro!', roles, mid: 'yt-mem-' + item.id });
      }
    }

    const pollingMs = Math.max((data.pollingIntervalMillis || 5000), 3000);
    clearTimeout(state.youtube.pollTimer);
    state.youtube.pollTimer = setTimeout(youtubePollChat, pollingMs);
  } catch(e) {
    console.error('[YouTube] ❌ Error en poll (excepción):', e.message);
    clearTimeout(state.youtube.pollTimer);
    state.youtube.pollTimer = setTimeout(youtubePollChat, 10000);
  }
}

async function connectYouTube() {
  if (!CONFIG.youtubeHandle && !CONFIG.youtubeChannelId) {
    console.log('[YouTube] ❌ Variables faltantes — define YOUTUBE_HANDLE o YOUTUBE_CHANNEL_ID');
    return;
  }
  if (!CONFIG.youtubeKey) {
    console.log('[YouTube] ❌ Falta YOUTUBE_API_KEY');
    return;
  }
  console.log('[YouTube] 🔄 Iniciando conexión...');

  // ✅ NUEVO: si ya tenemos channelId en state (de arranque con YOUTUBE_CHANNEL_ID), lo usamos directo
  if (!state.youtube.channelId) {
    console.log('[YouTube] Resolviendo channelId...');
    const channelId = await youtubeResolveChannelId(CONFIG.youtubeHandle || CONFIG.youtubeChannelId);
    if (!channelId) {
      console.log('[YouTube] ❌ No se pudo resolver channelId. Reintentando en 10 minutos...');
      setTimeout(connectYouTube, 10 * 60 * 1000);
      return;
    }
    state.youtube.channelId = channelId;
    console.log('[YouTube] ✅ ChannelId guardado:', channelId);
  } else {
    console.log('[YouTube] ✅ ChannelId ya disponible:', state.youtube.channelId);
  }

  const chatId = await youtubeGetLiveChatId(state.youtube.channelId);
  if (!chatId) {
    console.log('[YouTube] ⏳ Sin live activo. Reintentando en 5 minutos...');
    setTimeout(connectYouTube, 5 * 60 * 1000);
    return;
  }

  state.youtube.liveChatId     = chatId;
  state.youtube.nextPageToken  = null;
  state.youtube.connected      = true;
  console.log('[YouTube] ✅ Conectado al live chat:', chatId);
  broadcastStatus();
  youtubePollChat();
}

// ── HTTP ENDPOINTS ───────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  ok: true, uptime: Math.floor(process.uptime()), messages: state.msgCount,
  clients: state.clients.size, twitch: state.twitch.connected, kick: state.kick.connected,
  kickChatroomId: CONFIG.kickId || null, tiktok: state.tiktok.connected, youtube: state.youtube.connected,
  youtubeChannelId: state.youtube.channelId || null,
}));

app.get('/tiktok-preview', (req, res) => {
  const user = CONFIG.tiktok || req.query.user || '';
  res.send(`<!DOCTYPE html><html><body style="background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;flex-direction:column;gap:20px"><div style="font-size:60px">🎵</div><h2>TikTok no permite embeds</h2>${user?`<a href="https://www.tiktok.com/@${user}/live" style="background:#FF0050;color:#fff;padding:12px 28px;border-radius:999px;text-decoration:none;font-weight:700">🔴 Ver @${user} en vivo</a>`:''}</body></html>`);
});

app.post('/api/tiktok/restart', (req, res) => {
  state.tiktok.connected = false; state.tiktok.restartCount++;
  broadcastStatus(); connectTikTokConnector();
  res.json({ ok: true, restarts: state.tiktok.restartCount });
});

app.post('/api/kick/restart', (req, res) => {
  if (kickRetryTimeout) { clearTimeout(kickRetryTimeout); kickRetryTimeout = null; }
  state.kick.connected = false;
  CONFIG.kickId = process.env.KICK_CHANNEL_ID || '';
  broadcastStatus();
  connectKick();
  res.json({ ok: true });
});

app.post('/api/youtube/restart', (req, res) => {
  clearTimeout(state.youtube.pollTimer);
  state.youtube.connected = false; state.youtube.liveChatId = null;
  state.youtube.nextPageToken = null;
  // ✅ NUEVO: no borrar channelId si ya está hardcodeado — evita gastar cuota al reconectar
  if (!CONFIG.youtubeChannelId) {
    state.youtube.channelId = null;
  }
  broadcastStatus(); connectYouTube();
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => res.json({
  twitch:  { connected: state.twitch.connected,  channel: CONFIG.twitch },
  kick:    { connected: state.kick.connected,    channel: CONFIG.kick },
  tiktok:  { connected: state.tiktok.connected,  user: CONFIG.tiktok },
  youtube: { connected: state.youtube.connected, channelId: state.youtube.channelId || CONFIG.youtubeHandle },
  clients: state.clients.size, messages: state.msgCount, uptime: Math.floor(process.uptime()),
}));

// ── ARRANCAR ─────────────────────────────────────────────────
server.listen(CONFIG.port, () => {
  console.log(`\n🎮 MEEVE MULTICHAT SERVER v2 — FIXED`);
  console.log(`   Puerto       : ${CONFIG.port}`);
  console.log(`   Twitch       : ${CONFIG.twitch || '(no config)'}`);
  console.log(`   Kick         : ${CONFIG.kick || '(no config)'}`);
  console.log(`   TikTok       : ${CONFIG.tiktok || '(no config)'}`);
  console.log(`   YouTube      : ${CONFIG.youtubeHandle || '(no config)'}`);
  console.log(`   YT ChannelId : ${CONFIG.youtubeChannelId || '(se resolverá via API)'}\n`);
  connectTwitch();
  connectKick();
  connectTikTokConnector();
  connectYouTube();
});
