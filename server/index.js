// ============================================================
//  MEEVE MULTICHAT SERVER v2
//  ✅ Twitch via tmi.js
//  ✅ Kick via Pusher WebSocket
//  ✅ TikTok via tiktok-live-connector
//  ✅ YouTube via youtube-chat (sin API key, sin proxy browser, sin 429)
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

// YouTube: API v3 — polling desde el servidor (sin límites de IP, sin CORS)

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const CONFIG = {
  twitch:           process.env.TWITCH_CHANNEL      || '',
  kick:             process.env.KICK_CHANNEL        || '',
  kickId:           process.env.KICK_CHANNEL_ID     || '',
  tiktok:           process.env.TIKTOK_USERNAME     || '',
  youtubeHandle:    (process.env.YOUTUBE_HANDLE     || '').trim(),
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

const state = {
  clients:  new Set(),
  tiktok:   { connected: false, lastMsg: 0, instance: null, restartCount: 0 },
  twitch:   { connected: false },
  kick:     { connected: false },
  youtube:  { connected: false, videoId: null },
  msgCount: 0,
};

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

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  state.clients.forEach(ws => { if (ws.readyState === 1) ws.send(raw); });
  state.msgCount++;
}

function broadcastStatus() {
  broadcast({
    type: 'status',
    twitch: state.twitch.connected,
    kick:   state.kick.connected,
    tiktok: state.tiktok.connected,
    youtube: state.youtube.connected,
    youtubeVideoId: state.youtube.videoId || null,
    tiktokMode: CONFIG.tiktokMode,
    channels: {
      twitch:  CONFIG.twitch,
      kick:    CONFIG.kick,
      tiktok:  CONFIG.tiktok,
      youtube: CONFIG.youtubeHandle,
    }
  });
}

wss.on('connection', (ws) => {
  state.clients.add(ws);
  ws.send(JSON.stringify({
    type: 'status',
    twitch: state.twitch.connected, kick: state.kick.connected,
    tiktok: state.tiktok.connected, youtube: state.youtube.connected,
    youtubeVideoId: state.youtube.videoId || null,
    tiktokMode: CONFIG.tiktokMode,
    channels: { twitch: CONFIG.twitch, kick: CONFIG.kick, tiktok: CONFIG.tiktok, youtube: CONFIG.youtubeHandle }
  }));
  ws.on('close', () => state.clients.delete(ws));
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'custom_message')    broadcast({ type: 'custom', platform: 'custom', chatname: msg.user || 'Tú', chatmessage: msg.text, nameColor: '#FF6B9D', mid: 'custom-' + Date.now() });
      if (msg.type === 'highlight')         broadcast({ type: 'highlight', platform: msg.platform || 'custom', chatname: msg.chatname || '', chatmessage: msg.chatmessage || '', chatimg: msg.chatimg || null, nameColor: msg.nameColor || '#FF6B9D', roles: msg.roles || [], chatemotes: msg.chatemotes || [], mid: msg.mid || ('hl-' + Date.now()) });
      if (msg.type === 'highlight_clear')   broadcast({ type: 'highlight_clear' });
      if (msg.type === 'kick_message')      handleKickMessageFromBrowser(msg);
      if (msg.type === 'kick_donation')     handleKickDonationFromBrowser(msg);
      if (msg.type === 'kick_disconnected') { state.kick.connected = false; broadcastStatus(); }
      if (msg.type === 'kick_connected')    { state.kick.connected = true;  broadcastStatus(); }
      // YouTube API v3 — conectar/desconectar desde el dashboard
      if (msg.type === 'youtube_connect') {
        if (msg.videoId) connectYouTubeApi(msg.videoId);
      }
      if (msg.type === 'youtube_disconnected') {
        disconnectYouTubeApi();
      }
    } catch(e) {}
  });
});

// ══ TWITCH ══
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
    const bitsAmount = tags.bits ? parseInt(tags.bits) : 0;
    const twitchUser = tags['display-name'] || tags.username || '';
    getTwitchAvatar(twitchUser, (avatar) => {
      if (bitsAmount > 0) {
        broadcast({ type: 'donation', platform: 'twitch', donationType: 'bits', chatname: twitchUser, chatmessage: message.replace(/cheer\d+\s*/gi, '').trim() || `¡${bitsAmount} Bits!`, chatemotes, amount: bitsAmount, currency: 'BITS', nameColor: tags.color || '#9146FF', chatimg: avatar || null, roles, mid: 'tw-bits-' + Date.now() });
      } else {
        broadcast({ type: 'twitch', platform: 'twitch', chatname: twitchUser, chatmessage: message, chatemotes, nameColor: tags.color || '#9146FF', chatimg: avatar || null, roles, mid: tags.id || ('tw-' + Date.now()) });
      }
    });
  });
  client.on('subscription',   (ch, u, method, msg, us) => broadcast({ type: 'donation', platform: 'twitch', donationType: 'sub',      chatname: us['display-name'] || u, chatmessage: msg || '¡Nuevo suscriptor!',            subPlan: method?.plan || 'Prime', nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-sub-'      + Date.now() }));
  client.on('resub',          (ch, u, months, msg, us, methods) => broadcast({ type: 'donation', platform: 'twitch', donationType: 'resub',    chatname: us['display-name'] || u, chatmessage: msg || `¡${months} meses!`,            months, subPlan: methods?.plan || 'Prime', nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-resub-'    + Date.now() }));
  client.on('subgift',        (ch, u, s, recipient, methods, us) => broadcast({ type: 'donation', platform: 'twitch', donationType: 'subgift',  chatname: us['display-name'] || u, chatmessage: `¡Regaló una sub a ${recipient}!`, recipient, subPlan: methods?.plan || '1000',  nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-gift-'     + Date.now() }));
  client.on('submysterygift', (ch, u, num, methods, us) =>         broadcast({ type: 'donation', platform: 'twitch', donationType: 'subgift',  chatname: us['display-name'] || u, chatmessage: `¡Regaló ${num} subs!`,               amount: num,                             nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-massgift-' + Date.now() }));
}

// ══ KICK ══
app.get('/api/kick/channel-id',  (req, res) => res.json({ kickId: CONFIG.kickId || null, channel: CONFIG.kick }));
app.post('/api/kick/channel-id', (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId requerido' });
  CONFIG.kickId = String(channelId);
  res.json({ ok: true, kickId: CONFIG.kickId });
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
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}
async function connectKick() {
  if (!CONFIG.kick) return;
  if (!CONFIG.kickId) {
    const id = await resolveKickChannelId(CONFIG.kick);
    if (!id) { kickRetryTimeout = setTimeout(connectKick, 60000); return; }
    CONFIG.kickId = id;
    console.log(`[Kick] ✅ Chatroom ID: ${CONFIG.kickId}`);
  }
  tryKickPusher(CONFIG.kickId);
}
function tryKickPusher(channelId) {
  if (kickPusherWs) { try { kickPusherWs.terminate(); } catch(e) {} kickPusherWs = null; }
  if (kickPingInterval) { clearInterval(kickPingInterval); kickPingInterval = null; }
  const url = PUSHER_URLS[kickUrlIndex % PUSHER_URLS.length];
  let ws;
  try { ws = new NodeWS(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); }
  catch(e) { kickRetryTimeout = setTimeout(() => { kickUrlIndex++; tryKickPusher(channelId); }, kickRetryDelay); return; }
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
    if (event === 'App\\Events\\GiftedSubscriptionsEvent' || event === 'App.Events.GiftedSubscriptionsEvent') {
      const gifter = (d.gifted_by && d.gifted_by.username) || 'Anónimo', qty = (d.gifted_usernames && d.gifted_usernames.length) || 1;
      getKickAvatar(gifter, (avatar) => broadcast({ type: 'donation', platform: 'kick', donationType: 'giftedsub', chatname: gifter, chatmessage: `¡Regaló ${qty} sub(s)!`, amount: qty, chatimg: avatar || null, nameColor: '#53FC18', roles: [], mid: 'kick-gift-' + Date.now() }));
    }
    if (event === 'App\\Events\\SubscriptionEvent' || event === 'App.Events.SubscriptionEvent') {
      const uname = (d.usernames && d.usernames[0]) || d.username || 'KickUser';
      getKickAvatar(uname, (avatar) => broadcast({ type: 'donation', platform: 'kick', donationType: 'sub', chatname: uname, chatmessage: '¡Se suscribió!', chatimg: avatar || null, nameColor: '#53FC18', roles: [], mid: 'kick-sub-' + Date.now() }));
    }
  });
  ws.on('close', () => {
    if (kickPingInterval) { clearInterval(kickPingInterval); kickPingInterval = null; }
    state.kick.connected = false; broadcastStatus();
    kickUrlIndex++; kickRetryDelay = Math.min(kickRetryDelay * 1.5, 60000);
    kickRetryTimeout = setTimeout(() => tryKickPusher(channelId), kickRetryDelay);
  });
  ws.on('error', (e) => console.error('[Kick] WS error:', e.message));
}

// ══ TIKTOK ══
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

// ══ YOUTUBE — API v3 polling desde el servidor ══
// Soporta múltiples API keys: YOUTUBE_API_KEY, YOUTUBE_API_KEY_2, YOUTUBE_API_KEY_3, etc.
const YOUTUBE_API_KEYS = (() => {
  const keys = [];
  if (process.env.YOUTUBE_API_KEY)   keys.push(process.env.YOUTUBE_API_KEY);
  if (process.env.YOUTUBE_API_KEY_2) keys.push(process.env.YOUTUBE_API_KEY_2);
  if (process.env.YOUTUBE_API_KEY_3) keys.push(process.env.YOUTUBE_API_KEY_3);
  if (process.env.YOUTUBE_API_KEY_4) keys.push(process.env.YOUTUBE_API_KEY_4);
  return keys.filter(Boolean);
})();

// Para compatibilidad, YOUTUBE_API_KEY apunta a la key activa actual
let ytCurrentKeyIndex = 0;
function getYouTubeApiKey() { return YOUTUBE_API_KEYS[ytCurrentKeyIndex] || ''; }
function rotateYouTubeApiKey() {
  if (YOUTUBE_API_KEYS.length <= 1) return false; // No hay más keys
  const prevIndex = ytCurrentKeyIndex;
  ytCurrentKeyIndex = (ytCurrentKeyIndex + 1) % YOUTUBE_API_KEYS.length;
  console.log(`[YouTube] 🔄 Rotando API key [${prevIndex + 1}/${YOUTUBE_API_KEYS.length}] → [${ytCurrentKeyIndex + 1}/${YOUTUBE_API_KEYS.length}]`);
  return true;
}

let ytPollState = {
  active: false,
  videoId: null,
  liveChatId: null,
  pageToken: null,
  pollTimer: null,
  errorCount: 0,
  seenIds: new Set(),
  keyExhaustedCount: 0, // cuántas keys seguidas fallaron por 403
};

async function ytApiGet(path) {
  return new Promise((resolve, reject) => {
    const url = `https://www.googleapis.com/youtube/v3/${path}&key=${getYouTubeApiKey()}`;
    const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getLiveChatId(videoId) {
  const r = await ytApiGet(`videos?part=liveStreamingDetails&id=${videoId}`);
  if (r.status !== 200) throw new Error(`API error ${r.status}: ${JSON.stringify(r.data.error)}`);
  const items = r.data.items;
  if (!items || !items.length) throw new Error('Video no encontrado');
  const details = items[0].liveStreamingDetails;
  if (!details || !details.activeLiveChatId) throw new Error('El video no tiene chat en vivo activo');
  return details.activeLiveChatId;
}

async function pollYouTubeChat() {
  if (!ytPollState.active || !ytPollState.liveChatId) return;
  if (!getYouTubeApiKey()) {
    console.error('[YouTube] YOUTUBE_API_KEY no configurada');
    return;
  }

  try {
    let path = `liveChat/messages?part=snippet,authorDetails&liveChatId=${ytPollState.liveChatId}&maxResults=200`;
    if (ytPollState.pageToken) path += `&pageToken=${ytPollState.pageToken}`;

    const r = await ytApiGet(path);

    if (r.status === 403) {
      const errMsg = r.data.error?.message || 'error 403';
      console.error(`[YouTube] ⚠️ API key [${ytCurrentKeyIndex + 1}/${YOUTUBE_API_KEYS.length}] cuota agotada o inválida:`, errMsg);

      // Intentar con la siguiente key
      if (rotateYouTubeApiKey()) {
        ytPollState.keyExhaustedCount++;
        // Si ya probamos todas las keys, detenemos
        if (ytPollState.keyExhaustedCount >= YOUTUBE_API_KEYS.length) {
          console.error('[YouTube] ❌ Todas las API keys agotadas. Deteniendo polling.');
          state.youtube.connected = false;
          broadcastStatus();
          ytPollState.active = false;
          ytPollState.keyExhaustedCount = 0;
          broadcast({ type: 'system', platform: 'system', chatname: 'Sistema', chatmessage: `❌ YouTube: todas las API keys (${YOUTUBE_API_KEYS.length}) agotadas. Reinicia mañana.`, nameColor: '#ff4444', mid: 'sys-yt-' + Date.now() });
          return;
        }
        broadcast({ type: 'system', platform: 'system', chatname: 'Sistema', chatmessage: `🔄 YouTube: key ${ytCurrentKeyIndex}/${YOUTUBE_API_KEYS.length} agotada, usando key ${ytCurrentKeyIndex + 1}...`, nameColor: '#ffaa00', mid: 'sys-yt-' + Date.now() });
        // Reintenta inmediatamente con la nueva key
        if (ytPollState.active) ytPollState.pollTimer = setTimeout(pollYouTubeChat, 1000);
        return;
      }

      // Solo hay una key, comportamiento original
      state.youtube.connected = false;
      broadcastStatus();
      ytPollState.active = false;
      broadcast({ type: 'system', platform: 'system', chatname: 'Sistema', chatmessage: '⚠️ YouTube API: ' + errMsg, nameColor: '#ffaa00', mid: 'sys-yt-' + Date.now() });
      return;
    }
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);

    ytPollState.errorCount = 0;
    ytPollState.keyExhaustedCount = 0; // Poll exitoso — resetear contador de keys fallidas
    const data = r.data;

    // Actualizar pageToken para el próximo poll
    if (data.nextPageToken) ytPollState.pageToken = data.nextPageToken;

    // Procesar mensajes
    const items = data.items || [];
    items.forEach(item => {
      const id = item.id;
      if (!id || ytPollState.seenIds.has(id)) return;
      ytPollState.seenIds.add(id);
      if (ytPollState.seenIds.size > 1000) {
        const arr = Array.from(ytPollState.seenIds);
        ytPollState.seenIds = new Set(arr.slice(arr.length - 500));
      }

      const snippet = item.snippet || {};
      const author  = item.authorDetails || {};
      const msgType = snippet.type || '';

      const name   = author.displayName || 'YouTuber';
      const avatar = author.profileImageUrl || null;
      const roles  = [];

      if (author.isChatOwner)      roles.push({ type: 'broadcaster', label: 'Streamer' });
      if (author.isChatModerator)  roles.push({ type: 'moderator',   label: 'Mod' });
      if (author.isChatSponsor)    roles.push({ type: 'member',      label: '⭐ Miembro' });
      if (author.isVerified)       roles.push({ type: 'verified',    label: '✓ Verificado' });

      if (msgType === 'superChatEvent') {
        const sc = snippet.superChatDetails || {};
        broadcast({
          type: 'donation', platform: 'youtube', donationType: 'superchat',
          chatname: name, chatmessage: sc.userComment || '¡Superchat!',
          chatimg: avatar, nameColor: '#FF0000', amount: (sc.amountMicros || 0) / 1000000,
          amountDisplay: sc.amountDisplayString || '', roles,
          mid: 'yt-sc-' + id
        });
        return;
      }

      if (msgType === 'memberMilestoneChatEvent' || msgType === 'newSponsorEvent') {
        broadcast({
          type: 'donation', platform: 'youtube', donationType: 'member',
          chatname: name, chatmessage: snippet.memberMilestoneChatDetails?.userComment || '¡Nuevo Miembro!',
          chatimg: avatar, nameColor: '#FF0000', roles, mid: 'yt-mb-' + id
        });
        return;
      }

      if (msgType === 'textMessageEvent') {
        const msgText = snippet.textMessageDetails?.messageText || '';
        if (!msgText) return;
        broadcast({
          type: 'youtube', platform: 'youtube',
          chatname: name, chatmessage: msgText,
          chatimg: avatar, nameColor: '#FF0000', roles,
          mid: 'yt-' + id
        });
      }
    });

    // Respetar el intervalo recomendado por YouTube
    const interval = Math.max((data.pollingIntervalMillis || 5000), 3000);
    if (ytPollState.active) ytPollState.pollTimer = setTimeout(pollYouTubeChat, interval);

  } catch(e) {
    ytPollState.errorCount++;
    console.error(`[YouTube] Error poll #${ytPollState.errorCount}:`, e.message);
    if (ytPollState.errorCount > 5) {
      console.error('[YouTube] Demasiados errores, deteniendo polling');
      state.youtube.connected = false;
      ytPollState.active = false;
      broadcastStatus();
      return;
    }
    if (ytPollState.active) ytPollState.pollTimer = setTimeout(pollYouTubeChat, 15000);
  }
}

async function connectYouTubeApi(videoId) {
  // Detener polling anterior
  if (ytPollState.pollTimer) { clearTimeout(ytPollState.pollTimer); ytPollState.pollTimer = null; }
  ytPollState.active    = false;
  ytPollState.pageToken = null;
  ytPollState.errorCount = 0;

  if (YOUTUBE_API_KEYS.length === 0) {
    console.error('[YouTube] YOUTUBE_API_KEY no configurada en variables de entorno');
    broadcast({ type: 'system', platform: 'system', chatname: 'Sistema', chatmessage: '⚠️ Falta YOUTUBE_API_KEY en las variables de entorno de Render', nameColor: '#ffaa00', mid: 'sys-yt-' + Date.now() });
    return;
  }

  // Resetear rotación al conectar
  ytCurrentKeyIndex = 0;
  ytPollState.keyExhaustedCount = 0;
  console.log(`[YouTube] Conectando con ${YOUTUBE_API_KEYS.length} API key(s) disponible(s)`);

  console.log(`[YouTube] Conectando a video ${videoId}...`);
  state.youtube.videoId = videoId;

  try {
    const liveChatId = await getLiveChatId(videoId);
    ytPollState.liveChatId = liveChatId;
    ytPollState.videoId    = videoId;
    ytPollState.active     = true;
    state.youtube.connected = true;
    state.youtube.videoId   = videoId;
    console.log(`[YouTube] ✅ Live chat conectado: ${liveChatId}`);
    broadcastStatus();
    // Primera poll con delay para obtener solo mensajes nuevos
    ytPollState.pollTimer = setTimeout(pollYouTubeChat, 2000);
  } catch(e) {
    console.error('[YouTube] Error al conectar:', e.message);
    state.youtube.connected = false;
    state.youtube.videoId   = null;
    broadcastStatus();
    broadcast({ type: 'system', platform: 'system', chatname: 'Sistema', chatmessage: '❌ YouTube: ' + e.message, nameColor: '#ff4444', mid: 'sys-yt-' + Date.now() });
  }
}

function disconnectYouTubeApi() {
  ytPollState.active = false;
  if (ytPollState.pollTimer) { clearTimeout(ytPollState.pollTimer); ytPollState.pollTimer = null; }
  ytPollState.liveChatId = null;
  ytPollState.pageToken  = null;
  ytPollState.videoId    = null;
  state.youtube.connected = false;
  state.youtube.videoId   = null;
  broadcastStatus();
}

// ══ ENDPOINTS VARIOS ══
app.get('/health', (req, res) => res.json({
  ok: true, uptime: Math.floor(process.uptime()), messages: state.msgCount,
  clients: state.clients.size, twitch: state.twitch.connected, kick: state.kick.connected,
  kickChatroomId: CONFIG.kickId || null, tiktok: state.tiktok.connected,
  youtube: state.youtube.connected, youtubeVideoId: state.youtube.videoId || null,
}));

app.get('/tiktok-preview', (req, res) => {
  const user = CONFIG.tiktok || req.query.user || '';
  res.send(`<!DOCTYPE html><html><body style="background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;flex-direction:column;gap:20px"><div style="font-size:60px">🎵</div><h2>TikTok no permite embeds</h2>${user ? `<a href="https://www.tiktok.com/@${user}/live" style="background:#FF0050;color:#fff;padding:12px 28px;border-radius:999px;text-decoration:none;font-weight:700">🔴 Ver @${user} en vivo</a>` : ''}</body></html>`);
});

app.post('/api/tiktok/restart', (req, res) => { state.tiktok.connected = false; state.tiktok.restartCount++; broadcastStatus(); connectTikTokConnector(); res.json({ ok: true, restarts: state.tiktok.restartCount }); });
app.post('/api/kick/restart',   (req, res) => { if (kickRetryTimeout) { clearTimeout(kickRetryTimeout); kickRetryTimeout = null; } state.kick.connected = false; CONFIG.kickId = process.env.KICK_CHANNEL_ID || ''; broadcastStatus(); connectKick(); res.json({ ok: true }); });

app.get('/api/status', (req, res) => res.json({
  twitch:  { connected: state.twitch.connected,  channel: CONFIG.twitch },
  kick:    { connected: state.kick.connected,    channel: CONFIG.kick },
  tiktok:  { connected: state.tiktok.connected,  user: CONFIG.tiktok },
  youtube: { connected: state.youtube.connected, videoId: state.youtube.videoId, handle: CONFIG.youtubeHandle },
  clients: state.clients.size, messages: state.msgCount, uptime: Math.floor(process.uptime()),
}));

// ══ ENDPOINTS YOUTUBE API v3 ══
app.post('/api/youtube/connect', (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId requerido' });
  connectYouTubeApi(videoId);
  res.json({ ok: true, videoId });
});

app.post('/api/youtube/disconnect', (req, res) => {
  disconnectYouTubeApi();
  res.json({ ok: true });
});

server.listen(CONFIG.port, () => {
  console.log(`\n🎮 MEEVE MULTICHAT SERVER v2 — BROWSER BRIDGE EDITION`);
  console.log(`   Puerto  : ${CONFIG.port}`);
  console.log(`   Twitch  : ${CONFIG.twitch || '(no config)'}`);
  console.log(`   Kick    : ${CONFIG.kick   || '(no config)'}`);
  console.log(`   TikTok  : ${CONFIG.tiktok || '(no config)'}`);
  console.log(`   YouTube : API v3 ${YOUTUBE_API_KEYS.length > 0 ? `✅ ${YOUTUBE_API_KEYS.length} key(s) configurada(s)` : '❌ falta YOUTUBE_API_KEY'}\n`);
  connectTwitch();
  connectKick();
  connectTikTokConnector();
});
