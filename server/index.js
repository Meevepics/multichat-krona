// ============================================================
//  MEEVE MULTICHAT SERVER v2.2
//  ✅ Twitch via tmi.js
//  ✅ Kick via Pusher WebSocket + OAuth API (canjes Channel Points)
//  ✅ TikTok via tiktok-live-connector
//  ✅ YouTube via API v3 (multi-key + auto-detect live)
// ============================================================

const express    = require('express');
const http       = require('http');
const https      = require('https');
const { WebSocketServer } = require('ws');
const tmi        = require('tmi.js');
const crypto     = require('crypto');

let WebcastPushConnection;
try {
  ({ WebcastPushConnection } = require('tiktok-live-connector'));
} catch(e) { console.log('[TikTok] tiktok-live-connector no disponible'); }

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const CONFIG = {
  twitch:           process.env.TWITCH_CHANNEL      || '',
  kick:             process.env.KICK_CHANNEL        || '',
  kickId:           process.env.KICK_CHANNEL_ID     || '',
  tiktok:           process.env.TIKTOK_USERNAME     || '',
  youtubeHandle:    (process.env.YOUTUBE_HANDLE     || '').trim(),
  youtubeChannelId: (process.env.YOUTUBE_CHANNEL_ID || '').trim(),
  port:             process.env.PORT                || 3000,
  tiktokMode:       process.env.TIKTOK_MODE         || 'connector',
  // Kick OAuth
  kickClientId:     process.env.KICK_CLIENT_ID      || '',
  kickClientSecret: process.env.KICK_CLIENT_SECRET  || '',
  kickRedirectUri:  process.env.KICK_REDIRECT_URI   || 'https://multichat-krona-5uts.onrender.com/auth/kick/callback',
};

// Kick OAuth — estado en memoria
const kickOAuth = {
  accessToken:  process.env.KICK_ACCESS_TOKEN  || '',
  refreshToken: process.env.KICK_REFRESH_TOKEN || '',
  expiresAt:    0,
  userId:       '',
  channelId:    '',
  oauthState:   '',
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const state = {
  clients:   new Set(),
  tiktok:    { connected: false, lastMsg: 0, instance: null, restartCount: 0 },
  twitch:    { connected: false },
  kick:      { connected: false },
  kickOAuth: { connected: false },
  youtube:   { connected: false, videoId: null },
  msgCount:  0,
};

// ══════════════════════════════════════════════════════
// UTILIDADES
// ══════════════════════════════════════════════════════
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
  const req = https.get(`https://kick.com/api/v2/channels/${slug}`, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }, (res) => {
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

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  state.clients.forEach(ws => { if (ws.readyState === 1) ws.send(raw); });
  state.msgCount++;
}

function broadcastStatus() {
  broadcast({
    type:       'status',
    twitch:     state.twitch.connected,
    kick:       state.kick.connected,
    kickOAuth:  state.kickOAuth.connected,
    tiktok:     state.tiktok.connected,
    youtube:    state.youtube.connected,
    youtubeVideoId: state.youtube.videoId || null,
    tiktokMode: CONFIG.tiktokMode,
    channels: { twitch: CONFIG.twitch, kick: CONFIG.kick, tiktok: CONFIG.tiktok, youtube: CONFIG.youtubeHandle }
  });
}

wss.on('connection', (ws) => {
  state.clients.add(ws);
  ws.send(JSON.stringify({
    type: 'status',
    twitch: state.twitch.connected, kick: state.kick.connected,
    kickOAuth: state.kickOAuth.connected,
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
      if (msg.type === 'youtube_connect' && msg.videoId) connectYouTubeApi(msg.videoId);
      if (msg.type === 'youtube_disconnected') disconnectYouTubeApi();
    } catch(e) {}
  });
});

// ══════════════════════════════════════════════════════
// TWITCH
// ══════════════════════════════════════════════════════
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
  client.on('subscription',   (ch, u, method, msg, us)          => broadcast({ type: 'donation', platform: 'twitch', donationType: 'sub',     chatname: us['display-name'] || u, chatmessage: msg || '¡Nuevo suscriptor!',          subPlan: method?.plan || 'Prime', nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-sub-'      + Date.now() }));
  client.on('resub',          (ch, u, months, msg, us, methods)  => broadcast({ type: 'donation', platform: 'twitch', donationType: 'resub',   chatname: us['display-name'] || u, chatmessage: msg || `¡${months} meses!`,          months, subPlan: methods?.plan || 'Prime', nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-resub-'    + Date.now() }));
  client.on('subgift',        (ch, u, s, recipient, methods, us) => broadcast({ type: 'donation', platform: 'twitch', donationType: 'subgift', chatname: us['display-name'] || u, chatmessage: `¡Regaló una sub a ${recipient}!`, recipient, subPlan: methods?.plan || '1000', nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-gift-'     + Date.now() }));
  client.on('submysterygift', (ch, u, num, methods, us)          => broadcast({ type: 'donation', platform: 'twitch', donationType: 'subgift', chatname: us['display-name'] || u, chatmessage: `¡Regaló ${num} subs!`, amount: num, nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-massgift-' + Date.now() }));
}

// ══════════════════════════════════════════════════════
// KICK — PUSHER (chat normal, subs, gifts via WebSocket público)
// ══════════════════════════════════════════════════════
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
  if (data.chatimg) {
    broadcast({ type: 'kick', platform: 'kick', chatname: username, chatmessage: data.chatmessage, nameColor: data.nameColor || '#53FC18', chatimg: data.chatimg, roles: data.roles || [], chatemotes: data.chatemotes || [], mid: data.mid || ('kick-' + Date.now()) });
  } else {
    getKickAvatar(username, (avatar) => broadcast({ type: 'kick', platform: 'kick', chatname: username, chatmessage: data.chatmessage, nameColor: data.nameColor || '#53FC18', chatimg: avatar || null, roles: data.roles || [], chatemotes: data.chatemotes || [], mid: data.mid || ('kick-' + Date.now()) }));
  }
}

function handleKickDonationFromBrowser(data) {
  getKickAvatar(data.chatname || 'Unknown', (avatar) => broadcast({
    type: 'donation', platform: 'kick', donationType: data.donationType || 'giftedsub',
    chatname: data.chatname || 'Unknown', chatmessage: data.chatmessage || '',
    amount: data.amount || null, currency: data.currency || null, months: data.months || null,
    rewardTitle: data.rewardTitle || null,
    nameColor: data.nameColor || '#53FC18', chatimg: avatar || null, roles: data.roles || [],
    mid: data.mid || ('kick-don-' + Date.now())
  }));
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
    ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `channel.${channelId}` } }));
    kickPingInterval = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); }, 25000);
  });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch(e) { return; }
    const event = msg.event || '';
    if (event === 'pusher:connection_established' || event === 'pusher:pong') return;
    if (event === 'pusher_internal:subscription_succeeded') { state.kick.connected = true; broadcastStatus(); return; }
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
  ws.on('error', (e) => console.error('[Kick Pusher] WS error:', e.message));
}

// ══════════════════════════════════════════════════════
// KICK OAUTH — Canjes de Channel Points via EventSub
// ══════════════════════════════════════════════════════

const KICK_SCOPES = 'user:read channel:read events:subscribe channel:read:redemptions';

// PASO 1 — Página de autenticación
app.get('/auth/kick', (req, res) => {
  if (!CONFIG.kickClientId) {
    return res.status(500).send(`<html><body style="background:#0a0a0a;color:#fff;font-family:monospace;padding:40px;text-align:center"><h2 style="color:#ff4444">❌ KICK_CLIENT_ID no configurado en Render</h2></body></html>`);
  }
  kickOAuth.oauthState = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id:     CONFIG.kickClientId,
    redirect_uri:  CONFIG.kickRedirectUri,
    response_type: 'code',
    scope:         KICK_SCOPES,
    state:         kickOAuth.oauthState,
  });
  const authUrl = `https://id.kick.com/oauth/authorize?${params.toString()}`;
  console.log('[Kick OAuth] Iniciando auth, redirigiendo a Kick...');
  res.redirect(authUrl);
});

// PASO 2 — Callback de Kick con el code
app.get('/auth/kick/callback', async (req, res) => {
  const { code, state: returnedState, error } = req.query;

  if (error) {
    return res.send(`<html><body style="background:#0a0a0a;color:#fff;font-family:monospace;padding:40px;text-align:center"><h2 style="color:#ff4444">❌ Error: ${error}</h2><p>Cerrá esta ventana y reintentá.</p></body></html>`);
  }
  if (returnedState !== kickOAuth.oauthState) {
    return res.status(400).send(`<html><body style="background:#0a0a0a;color:#fff;font-family:monospace;padding:40px;text-align:center"><h2 style="color:#ff4444">❌ State inválido</h2></body></html>`);
  }
  if (!code) {
    return res.status(400).send(`<html><body style="background:#0a0a0a;color:#fff;font-family:monospace;padding:40px;text-align:center"><h2 style="color:#ff4444">❌ No se recibió el code</h2></body></html>`);
  }

  try {
    const tokenBody = new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     CONFIG.kickClientId,
      client_secret: CONFIG.kickClientSecret,
      redirect_uri:  CONFIG.kickRedirectUri,
      code,
    }).toString();

    const tokenRes = await httpsRequest({
      hostname: 'id.kick.com',
      path:     '/oauth/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenBody) },
    }, tokenBody);

    if (tokenRes.status !== 200 || !tokenRes.data.access_token) {
      console.error('[Kick OAuth] Error token:', tokenRes.data);
      return res.send(`<html><body style="background:#0a0a0a;color:#fff;font-family:monospace;padding:40px;text-align:center"><h2 style="color:#ff4444">❌ Error al obtener token</h2><pre style="text-align:left;color:#aaa">${JSON.stringify(tokenRes.data, null, 2)}</pre></body></html>`);
    }

    kickOAuth.accessToken  = tokenRes.data.access_token;
    kickOAuth.refreshToken = tokenRes.data.refresh_token || '';
    kickOAuth.expiresAt    = Date.now() + ((tokenRes.data.expires_in || 3600) * 1000);
    console.log('[Kick OAuth] ✅ Token obtenido!');

    await loadKickUserInfo();
    connectKickEventSub();

    state.kickOAuth.connected = true;
    broadcastStatus();
    broadcast({ type: 'system', platform: 'system', chatname: 'Sistema', chatmessage: '✅ Kick OAuth conectado — Canjes de Channel Points activos 🎁', nameColor: '#53FC18', mid: 'sys-kick-' + Date.now() });

    res.send(`
      <html><body style="background:#0a0a0a;color:#fff;font-family:monospace;padding:60px;text-align:center">
        <div style="font-size:70px">✅</div>
        <h2 style="color:#53FC18;margin:20px 0">¡Kick conectado!</h2>
        <p style="color:#aaa;font-size:14px">Los canjes de Channel Points ya están activos en tu multichat.</p>
        <p style="color:#666;font-size:12px;margin-top:30px">Esta ventana se cerrará en 3 segundos...</p>
        <script>setTimeout(()=>window.close(),3000)</script>
      </body></html>
    `);
  } catch(e) {
    console.error('[Kick OAuth] Excepción en callback:', e.message);
    res.status(500).send(`<html><body style="background:#0a0a0a;color:#fff;font-family:monospace;padding:40px;text-align:center"><h2 style="color:#ff4444">❌ Error interno: ${e.message}</h2></body></html>`);
  }
});

// Cargar info del usuario autenticado
async function loadKickUserInfo() {
  try {
    const r = await httpsRequest({
      hostname: 'api.kick.com',
      path:     '/public/v1/users/me',
      method:   'GET',
      headers:  { 'Authorization': `Bearer ${kickOAuth.accessToken}`, 'Accept': 'application/json' },
    });
    if (r.status === 200 && r.data) {
      const u = r.data.data || r.data;
      kickOAuth.userId    = String(u.user_id || u.id || '');
      kickOAuth.channelId = String(u.channel_id || u.user_id || u.id || '');
      console.log(`[Kick OAuth] Usuario autenticado: ${u.username || u.name} | channelId: ${kickOAuth.channelId}`);
    } else {
      console.error('[Kick OAuth] loadKickUserInfo error:', r.status, r.data);
    }
  } catch(e) {
    console.error('[Kick OAuth] loadKickUserInfo excepción:', e.message);
  }
}

// EventSub WebSocket de Kick
let kickEventSubWs = null, kickEventSubRetry = null;

function connectKickEventSub() {
  if (kickEventSubWs) { try { kickEventSubWs.terminate(); } catch(e) {} kickEventSubWs = null; }
  if (kickEventSubRetry) { clearTimeout(kickEventSubRetry); kickEventSubRetry = null; }

  console.log('[Kick EventSub] Conectando al WebSocket...');
  try {
    kickEventSubWs = new NodeWS('wss://eventsub.kick.com/ws', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  } catch(e) {
    console.error('[Kick EventSub] Error al crear WS:', e.message);
    kickEventSubRetry = setTimeout(connectKickEventSub, 30000);
    return;
  }

  kickEventSubWs.on('open', () => console.log('[Kick EventSub] ✅ WebSocket abierto, esperando welcome...'));

  kickEventSubWs.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch(e) { return; }
    const msgType = msg.metadata?.message_type || msg.type || '';

    // Welcome → suscribirse a eventos con el session_id
    if (msgType === 'session_welcome' || msgType === 'connection_established') {
      const sessionId = msg.payload?.session?.id || msg.session_id || '';
      console.log('[Kick EventSub] Session ID recibido:', sessionId);
      if (sessionId) await subscribeKickEvents(sessionId);
      return;
    }

    // Keepalive
    if (msgType === 'session_keepalive' || msgType === 'keepalive') return;
    if (msgType === 'ping') { if (kickEventSubWs?.readyState === 1) kickEventSubWs.send(JSON.stringify({ type: 'pong' })); return; }

    // Evento real
    if (msgType === 'notification' || msgType === 'event' || msg.payload?.event) {
      const evType = msg.metadata?.subscription_type || msg.event_type || msg.payload?.subscription?.type || '';
      const evData = msg.payload?.event || msg.data || msg.event || {};
      handleKickOAuthEvent(evType, evData);
    }
  });

  kickEventSubWs.on('close', (code) => {
    console.log(`[Kick EventSub] Desconectado (${code}), reintentando en 15s...`);
    state.kickOAuth.connected = false;
    broadcastStatus();
    kickEventSubRetry = setTimeout(connectKickEventSub, 15000);
  });

  kickEventSubWs.on('error', (e) => console.error('[Kick EventSub] Error:', e.message));
}

// Suscribirse a los eventos usando el session_id del WS
async function subscribeKickEvents(sessionId) {
  if (!kickOAuth.accessToken) { console.error('[Kick EventSub] Sin access token para suscribirse'); return; }
  await refreshKickTokenIfNeeded();

  const broadcasterId = kickOAuth.userId || kickOAuth.channelId;
  if (!broadcasterId) {
    console.error('[Kick EventSub] Sin broadcaster ID. Cargando usuario...');
    await loadKickUserInfo();
  }

  const events = [
    'channel.points_redemption.created',   // ✅ CANJES
    'channel.subscription.new',
    'channel.subscription.renewal',
    'channel.subscription.gifts',
    'channel.followed',
  ];

  let successCount = 0;
  for (const eventType of events) {
    try {
      const body = JSON.stringify({
        type:      eventType,
        version:   '1',
        condition: { broadcaster_user_id: kickOAuth.userId || kickOAuth.channelId },
        transport: { method: 'websocket', session_id: sessionId }
      });
      const r = await httpsRequest({
        hostname: 'api.kick.com',
        path:     '/public/v1/events/subscriptions',
        method:   'POST',
        headers:  {
          'Authorization':  `Bearer ${kickOAuth.accessToken}`,
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Accept':         'application/json',
        },
      }, body);

      if (r.status === 200 || r.status === 201) {
        console.log(`[Kick EventSub] ✅ Suscrito: ${eventType}`);
        successCount++;
      } else if (r.status === 409) {
        console.log(`[Kick EventSub] Ya suscrito: ${eventType}`);
        successCount++;
      } else {
        console.error(`[Kick EventSub] ❌ Error suscripción ${eventType}: ${r.status}`, r.data);
      }
    } catch(e) {
      console.error(`[Kick EventSub] Excepción suscribiendo ${eventType}:`, e.message);
    }
  }

  if (successCount > 0) {
    state.kickOAuth.connected = true;
    broadcastStatus();
    console.log(`[Kick EventSub] ✅ ${successCount}/${events.length} suscripciones activas. Canjes listos.`);
  }
}

// Manejar eventos recibidos por OAuth
function handleKickOAuthEvent(eventType, data) {
  if (!eventType || !data) return;
  console.log(`[Kick OAuth Event] ${eventType}:`, JSON.stringify(data).slice(0, 300));

  // ✅ CANJES DE CHANNEL POINTS
  if (
    eventType === 'channel.points_redemption.created' ||
    eventType.includes('redemption') ||
    eventType.includes('points_redemption')
  ) {
    const username    = data.user?.username    || data.redeemer?.username || data.username    || 'Viewer';
    const rewardTitle = data.reward?.title     || data.reward_title       || data.title       || 'Recompensa';
    const cost        = data.reward?.cost      || data.cost               || 0;
    const userMsg     = data.user_input        || data.message            || '';
    getKickAvatar(username, (avatar) => broadcast({
      type:        'donation',
      platform:    'kick',
      donationType:'redemption',
      chatname:    username,
      chatmessage: userMsg,
      rewardTitle,
      cost,
      chatimg:     avatar || null,
      nameColor:   '#53FC18',
      roles:       [],
      mid:         data.id || data.redemption_id || ('kick-redeem-' + Date.now())
    }));
    return;
  }

  // Nueva suscripción
  if (eventType === 'channel.subscription.new') {
    const username = data.subscriber?.username || data.username || 'KickUser';
    getKickAvatar(username, (avatar) => broadcast({ type: 'donation', platform: 'kick', donationType: 'sub', chatname: username, chatmessage: '¡Se suscribió!', chatimg: avatar || null, nameColor: '#53FC18', roles: [], mid: 'kick-sub-oauth-' + Date.now() }));
    return;
  }

  // Resub
  if (eventType === 'channel.subscription.renewal') {
    const username = data.subscriber?.username || data.username || 'KickUser';
    const months   = data.months || data.duration || 1;
    getKickAvatar(username, (avatar) => broadcast({ type: 'donation', platform: 'kick', donationType: 'resub', chatname: username, chatmessage: `¡${months} mes(es) de sub!`, months, chatimg: avatar || null, nameColor: '#53FC18', roles: [], mid: 'kick-resub-oauth-' + Date.now() }));
    return;
  }

  // Subs regaladas
  if (eventType === 'channel.subscription.gifts') {
    const gifter = data.gifter?.username || data.username || 'Anónimo';
    const qty    = data.quantity || data.amount || 1;
    getKickAvatar(gifter, (avatar) => broadcast({ type: 'donation', platform: 'kick', donationType: 'giftedsub', chatname: gifter, chatmessage: `¡Regaló ${qty} sub(s)!`, amount: qty, chatimg: avatar || null, nameColor: '#53FC18', roles: [], mid: 'kick-gift-oauth-' + Date.now() }));
    return;
  }

  // Nuevo follow
  if (eventType === 'channel.followed') {
    const username = data.follower?.username || data.username || 'Alguien';
    getKickAvatar(username, (avatar) => broadcast({ type: 'donation', platform: 'kick', donationType: 'follow', chatname: username, chatmessage: '¡Siguió el canal! 💚', chatimg: avatar || null, nameColor: '#53FC18', roles: [], mid: 'kick-follow-oauth-' + Date.now() }));
  }
}

// Refresh automático del token
async function refreshKickTokenIfNeeded() {
  if (!kickOAuth.refreshToken) return;
  if (kickOAuth.expiresAt > Date.now() + 60000) return;
  console.log('[Kick OAuth] Refrescando token...');
  try {
    const body = new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     CONFIG.kickClientId,
      client_secret: CONFIG.kickClientSecret,
      refresh_token: kickOAuth.refreshToken,
    }).toString();
    const r = await httpsRequest({
      hostname: 'id.kick.com',
      path:     '/oauth/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, body);
    if (r.status === 200 && r.data.access_token) {
      kickOAuth.accessToken  = r.data.access_token;
      kickOAuth.refreshToken = r.data.refresh_token || kickOAuth.refreshToken;
      kickOAuth.expiresAt    = Date.now() + ((r.data.expires_in || 3600) * 1000);
      console.log('[Kick OAuth] ✅ Token refrescado');
    } else {
      console.error('[Kick OAuth] Error al refrescar:', r.data);
    }
  } catch(e) {
    console.error('[Kick OAuth] Excepción refresh:', e.message);
  }
}
setInterval(refreshKickTokenIfNeeded, 30 * 60 * 1000);

app.get('/api/kick/oauth/status', (req, res) => res.json({
  connected:  state.kickOAuth.connected,
  hasToken:   !!kickOAuth.accessToken,
  userId:     kickOAuth.userId   || null,
  channelId:  kickOAuth.channelId || null,
  expiresAt:  kickOAuth.expiresAt ? new Date(kickOAuth.expiresAt).toISOString() : null,
  authUrl:    '/auth/kick',
}));

// ══════════════════════════════════════════════════════
// TIKTOK
// ══════════════════════════════════════════════════════
async function connectTikTokConnector() {
  if (!CONFIG.tiktok || !WebcastPushConnection) return;
  const username = CONFIG.tiktok.startsWith('@') ? CONFIG.tiktok : '@' + CONFIG.tiktok;
  if (state.tiktok.instance) { try { state.tiktok.instance.disconnect(); } catch(e) {} state.tiktok.instance = null; }
  const conn = new WebcastPushConnection(username, { processInitialData: false, enableExtendedGiftInfo: true, enableWebsocketUpgrade: true, requestPollingIntervalMs: 2000, sessionId: process.env.TIKTOK_SESSION_ID || undefined });
  state.tiktok.instance = conn;
  try { await conn.connect(); state.tiktok.connected = true; state.tiktok.lastMsg = Date.now(); broadcastStatus(); }
  catch(e) { broadcastStatus(); setTimeout(() => connectTikTokConnector(), e.message?.includes('LIVE_NOT_FOUND') ? 60000 : e.message?.includes('403') ? 300000 : 15000); return; }
  conn.on('chat',       (data) => { state.tiktok.lastMsg = Date.now(); broadcast({ type: 'tiktok', platform: 'tiktok', chatname: data.uniqueId || data.nickname || 'TikToker', chatmessage: data.comment, chatimg: data.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-' + Date.now() + '-' + Math.random() }); });
  conn.on('gift',       (data) => { state.tiktok.lastMsg = Date.now(); if (data.giftType === 1 && !data.repeatEnd) return; const gn = data.giftName || data.extendedGiftInfo?.name || `Gift #${data.giftId}`, di = data.diamondCount || 0, qty = data.repeatCount || 1; broadcast({ type: 'donation', platform: 'tiktok', donationType: 'gift', chatname: data.uniqueId || 'TikToker', chatmessage: `¡Envió ${qty}x ${gn}! (${di * qty} 💎)`, giftName: gn, amount: di * qty, currency: 'DIAMONDS', quantity: qty, chatimg: data.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-gift-' + Date.now() }); });
  conn.on('subscribe',  (data) => broadcast({ type: 'donation', platform: 'tiktok', donationType: 'sub', chatname: data.uniqueId || 'TikToker', chatmessage: '¡Se suscribió!', chatimg: data.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-sub-' + Date.now() }));
  conn.on('disconnected', () => { state.tiktok.connected = false; broadcastStatus(); setTimeout(() => connectTikTokConnector(), 10000); });
  conn.on('error', (e) => console.error('[TikTok] Error:', e?.message || e));
}
setInterval(() => { if (state.tiktok.connected && state.tiktok.lastMsg > 0 && Date.now() - state.tiktok.lastMsg > 3 * 60 * 1000) { state.tiktok.connected = false; broadcastStatus(); connectTikTokConnector(); } }, 60000);

// ══════════════════════════════════════════════════════
// YOUTUBE — API v3 multi-key + auto-detect live
// ══════════════════════════════════════════════════════
const YOUTUBE_API_KEYS = (() => {
  const keys = [];
  if (process.env.YOUTUBE_API_KEY)   keys.push(process.env.YOUTUBE_API_KEY);
  if (process.env.YOUTUBE_API_KEY_2) keys.push(process.env.YOUTUBE_API_KEY_2);
  if (process.env.YOUTUBE_API_KEY_3) keys.push(process.env.YOUTUBE_API_KEY_3);
  if (process.env.YOUTUBE_API_KEY_4) keys.push(process.env.YOUTUBE_API_KEY_4);
  return keys.filter(Boolean);
})();

let ytCurrentKeyIndex = 0;
function getYouTubeApiKey() { return YOUTUBE_API_KEYS[ytCurrentKeyIndex] || ''; }
function rotateYouTubeApiKey() {
  if (YOUTUBE_API_KEYS.length <= 1) return false;
  ytCurrentKeyIndex = (ytCurrentKeyIndex + 1) % YOUTUBE_API_KEYS.length;
  return true;
}

let ytPollState = { active: false, videoId: null, liveChatId: null, pageToken: null, pollTimer: null, errorCount: 0, seenIds: new Set(), keyExhaustedCount: 0 };
let ytAutoDetectTimer = null;

async function ytApiGet(path) {
  return new Promise((resolve, reject) => {
    const url = `https://www.googleapis.com/youtube/v3/${path}&key=${getYouTubeApiKey()}`;
    const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch(e) { reject(new Error('JSON parse error')); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getLiveChatId(videoId) {
  const r = await ytApiGet(`videos?part=liveStreamingDetails&id=${videoId}`);
  if (r.status !== 200) throw new Error(`API error ${r.status}`);
  const items = r.data.items;
  if (!items || !items.length) throw new Error('Video no encontrado');
  const details = items[0].liveStreamingDetails;
  if (!details || !details.activeLiveChatId) throw new Error('Sin chat en vivo activo');
  return details.activeLiveChatId;
}

async function pollYouTubeChat() {
  if (!ytPollState.active || !ytPollState.liveChatId) return;
  if (!getYouTubeApiKey()) return;
  try {
    let path = `liveChat/messages?part=snippet,authorDetails&liveChatId=${ytPollState.liveChatId}&maxResults=200`;
    if (ytPollState.pageToken) path += `&pageToken=${ytPollState.pageToken}`;
    const r = await ytApiGet(path);
    if (r.status === 403) {
      if (rotateYouTubeApiKey()) { ytPollState.keyExhaustedCount++; if (ytPollState.keyExhaustedCount >= YOUTUBE_API_KEYS.length) { state.youtube.connected = false; broadcastStatus(); ytPollState.active = false; return; } if (ytPollState.active) ytPollState.pollTimer = setTimeout(pollYouTubeChat, 1000); return; }
      state.youtube.connected = false; broadcastStatus(); ytPollState.active = false; return;
    }
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    ytPollState.errorCount = 0; ytPollState.keyExhaustedCount = 0;
    if (r.data.nextPageToken) ytPollState.pageToken = r.data.nextPageToken;
    (r.data.items || []).forEach(item => {
      const id = item.id; if (!id || ytPollState.seenIds.has(id)) return;
      ytPollState.seenIds.add(id);
      if (ytPollState.seenIds.size > 1000) { const arr = Array.from(ytPollState.seenIds); ytPollState.seenIds = new Set(arr.slice(arr.length - 500)); }
      const snippet = item.snippet || {}, author = item.authorDetails || {}, msgType = snippet.type || '';
      const name = author.displayName || 'YouTuber', avatar = author.profileImageUrl || null, roles = [];
      if (author.isChatOwner)     roles.push({ type: 'broadcaster', label: 'Streamer' });
      if (author.isChatModerator) roles.push({ type: 'moderator',   label: 'Mod' });
      if (author.isChatSponsor)   roles.push({ type: 'member',      label: '⭐ Miembro' });
      if (author.isVerified)      roles.push({ type: 'verified',    label: '✓ Verificado' });
      if (msgType === 'superChatEvent') { const sc = snippet.superChatDetails || {}; broadcast({ type: 'donation', platform: 'youtube', donationType: 'superchat', chatname: name, chatmessage: sc.userComment || '¡Superchat!', chatimg: avatar, nameColor: '#FF0000', amount: (sc.amountMicros || 0) / 1000000, amountDisplay: sc.amountDisplayString || '', roles, mid: 'yt-sc-' + id }); return; }
      if (msgType === 'memberMilestoneChatEvent' || msgType === 'newSponsorEvent') { broadcast({ type: 'donation', platform: 'youtube', donationType: 'member', chatname: name, chatmessage: snippet.memberMilestoneChatDetails?.userComment || '¡Nuevo Miembro!', chatimg: avatar, nameColor: '#FF0000', roles, mid: 'yt-mb-' + id }); return; }
      if (msgType === 'textMessageEvent') { const t = snippet.textMessageDetails?.messageText || ''; if (!t) return; broadcast({ type: 'youtube', platform: 'youtube', chatname: name, chatmessage: t, chatimg: avatar, nameColor: '#FF0000', roles, mid: 'yt-' + id }); }
    });
    const interval = Math.max((r.data.pollingIntervalMillis || 5000), 3000);
    if (ytPollState.active) ytPollState.pollTimer = setTimeout(pollYouTubeChat, interval);
  } catch(e) {
    ytPollState.errorCount++;
    if (ytPollState.errorCount > 5) { state.youtube.connected = false; ytPollState.active = false; broadcastStatus(); return; }
    if (ytPollState.active) ytPollState.pollTimer = setTimeout(pollYouTubeChat, 15000);
  }
}

async function connectYouTubeApi(videoId) {
  if (ytPollState.pollTimer) { clearTimeout(ytPollState.pollTimer); ytPollState.pollTimer = null; }
  if (ytAutoDetectTimer)     { clearTimeout(ytAutoDetectTimer);     ytAutoDetectTimer = null; }
  ytPollState.active = false; ytPollState.pageToken = null; ytPollState.errorCount = 0;
  if (!YOUTUBE_API_KEYS.length) { broadcast({ type: 'system', platform: 'system', chatname: 'Sistema', chatmessage: '⚠️ Falta YOUTUBE_API_KEY', nameColor: '#ffaa00', mid: 'sys-yt-' + Date.now() }); return; }
  ytCurrentKeyIndex = 0; ytPollState.keyExhaustedCount = 0; state.youtube.videoId = videoId;
  try {
    const liveChatId = await getLiveChatId(videoId);
    ytPollState.liveChatId = liveChatId; ytPollState.videoId = videoId; ytPollState.active = true;
    state.youtube.connected = true; state.youtube.videoId = videoId; broadcastStatus();
    ytPollState.pollTimer = setTimeout(pollYouTubeChat, 2000);
  } catch(e) {
    state.youtube.connected = false; state.youtube.videoId = null; broadcastStatus();
    broadcast({ type: 'system', platform: 'system', chatname: 'Sistema', chatmessage: '❌ YouTube: ' + e.message, nameColor: '#ff4444', mid: 'sys-yt-' + Date.now() });
  }
}

function disconnectYouTubeApi() {
  ytPollState.active = false;
  if (ytPollState.pollTimer) { clearTimeout(ytPollState.pollTimer); ytPollState.pollTimer = null; }
  if (ytAutoDetectTimer)     { clearTimeout(ytAutoDetectTimer);     ytAutoDetectTimer = null; }
  ytPollState.liveChatId = null; ytPollState.pageToken = null; ytPollState.videoId = null;
  state.youtube.connected = false; state.youtube.videoId = null; broadcastStatus();
}

async function autoConnectYouTubeLive() {
  if (ytAutoDetectTimer) { clearTimeout(ytAutoDetectTimer); ytAutoDetectTimer = null; }
  if (ytPollState.active && ytPollState.videoId) return;
  const channelId = CONFIG.youtubeChannelId, handle = CONFIG.youtubeHandle.replace('@', '');
  if (!channelId && !handle) return;
  if (!getYouTubeApiKey()) return;
  try {
    let searchPath;
    if (channelId) { searchPath = `search?part=snippet&channelId=${channelId}&eventType=live&type=video&maxResults=1&order=date`; }
    else {
      const rr = await ytApiGet(`channels?part=id&forHandle=${encodeURIComponent('@' + handle)}`);
      if (rr.status !== 200 || !rr.data.items?.length) { ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, 10 * 60 * 1000); return; }
      CONFIG.youtubeChannelId = rr.data.items[0].id;
      searchPath = `search?part=snippet&channelId=${CONFIG.youtubeChannelId}&eventType=live&type=video&maxResults=1&order=date`;
    }
    const r = await ytApiGet(searchPath);
    if (r.status !== 200 || !r.data.items?.length) { ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, 5 * 60 * 1000); return; }
    const videoId = r.data.items[0].id?.videoId;
    if (!videoId) { ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, 5 * 60 * 1000); return; }
    console.log(`[YouTube] ✅ Live detectado: "${r.data.items[0].snippet?.title}" → ${videoId}`);
    await connectYouTubeApi(videoId);
    ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, 30 * 60 * 1000);
  } catch(e) {
    ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, 10 * 60 * 1000);
  }
}

// ══════════════════════════════════════════════════════
// ENDPOINTS
// ══════════════════════════════════════════════════════
app.get('/health', (req, res) => res.json({
  ok: true, uptime: Math.floor(process.uptime()), messages: state.msgCount, clients: state.clients.size,
  twitch: state.twitch.connected, kick: state.kick.connected,
  kickOAuth: state.kickOAuth.connected, kickHasToken: !!kickOAuth.accessToken,
  tiktok: state.tiktok.connected, youtube: state.youtube.connected, youtubeVideoId: state.youtube.videoId || null,
}));

app.get('/tiktok-preview', (req, res) => {
  const user = CONFIG.tiktok || req.query.user || '';
  res.send(`<!DOCTYPE html><html><body style="background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;flex-direction:column;gap:20px"><div style="font-size:60px">🎵</div><h2>TikTok no permite embeds</h2>${user ? `<a href="https://www.tiktok.com/@${user}/live" style="background:#FF0050;color:#fff;padding:12px 28px;border-radius:999px;text-decoration:none;font-weight:700">🔴 Ver @${user} en vivo</a>` : ''}</body></html>`);
});

app.post('/api/tiktok/restart', (req, res) => { state.tiktok.connected = false; state.tiktok.restartCount++; broadcastStatus(); connectTikTokConnector(); res.json({ ok: true }); });
app.post('/api/kick/restart',   (req, res) => { if (kickRetryTimeout) { clearTimeout(kickRetryTimeout); kickRetryTimeout = null; } state.kick.connected = false; CONFIG.kickId = process.env.KICK_CHANNEL_ID || ''; broadcastStatus(); connectKick(); res.json({ ok: true }); });

app.get('/api/status', (req, res) => res.json({
  twitch:    { connected: state.twitch.connected,    channel:  CONFIG.twitch },
  kick:      { connected: state.kick.connected,      channel:  CONFIG.kick },
  kickOAuth: { connected: state.kickOAuth.connected, hasToken: !!kickOAuth.accessToken, authUrl: '/auth/kick' },
  tiktok:    { connected: state.tiktok.connected,    user:     CONFIG.tiktok },
  youtube:   { connected: state.youtube.connected,   videoId:  state.youtube.videoId, handle: CONFIG.youtubeHandle },
  clients: state.clients.size, messages: state.msgCount, uptime: Math.floor(process.uptime()),
}));

app.post('/api/youtube/connect',    (req, res) => { const { videoId } = req.body; if (!videoId) return res.status(400).json({ error: 'videoId requerido' }); connectYouTubeApi(videoId); res.json({ ok: true, videoId }); });
app.post('/api/youtube/disconnect', (req, res) => { disconnectYouTubeApi(); res.json({ ok: true }); });

// ══════════════════════════════════════════════════════
// ARRANQUE
// ══════════════════════════════════════════════════════
server.listen(CONFIG.port, () => {
  console.log(`\n🎮 MEEVE MULTICHAT SERVER v2.2`);
  console.log(`   Puerto       : ${CONFIG.port}`);
  console.log(`   Twitch       : ${CONFIG.twitch  || '(no config)'}`);
  console.log(`   Kick         : ${CONFIG.kick    || '(no config)'}`);
  console.log(`   Kick OAuth   : ${CONFIG.kickClientId ? '✅ Client ID configurado' : '❌ falta KICK_CLIENT_ID'}`);
  console.log(`   TikTok       : ${CONFIG.tiktok  || '(no config)'}`);
  console.log(`   YouTube API  : ${YOUTUBE_API_KEYS.length > 0 ? `✅ ${YOUTUBE_API_KEYS.length} key(s)` : '❌ falta YOUTUBE_API_KEY'}`);
  console.log(`   YT Canal     : ${CONFIG.youtubeChannelId || CONFIG.youtubeHandle || '(solo manual)'}`);

  if (CONFIG.kickClientId) {
    console.log(`\n   👉 Para activar canjes de Kick abrí en el navegador:`);
    console.log(`      https://multichat-krona-5uts.onrender.com/auth/kick\n`);
  }

  connectTwitch();
  connectKick();
  connectTikTokConnector();

  // Si ya hay token guardado en env, reconectar sin pasar por el browser
  if (kickOAuth.accessToken && CONFIG.kickClientId) {
    console.log('[Kick OAuth] Token encontrado en variables de entorno, reconectando EventSub...');
    kickOAuth.expiresAt = Date.now() + (3600 * 1000);
    loadKickUserInfo().then(() => connectKickEventSub());
  }

  if (CONFIG.youtubeChannelId || CONFIG.youtubeHandle) {
    setTimeout(autoConnectYouTubeLive, 6000);
  }
});
