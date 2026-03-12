// ============================================================
//  MEEVE MULTICHAT SERVER v2.5
//  ✅ Twitch via tmi.js
//  ✅ Kick via Pusher WebSocket (chat) + OAuth 2.1 PKCE + Webhooks (canjes)
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
  kickClientId:     process.env.KICK_CLIENT_ID      || '',
  kickClientSecret: process.env.KICK_CLIENT_SECRET  || '',
  kickRedirectUri:  process.env.KICK_REDIRECT_URI   || 'https://multichat-krona-5uts.onrender.com/auth/kick/callback',
  kickWebhookSecret: process.env.KICK_WEBHOOK_SECRET || '',
  kickBroadcasterId: process.env.KICK_BROADCASTER_ID || '',
};

const kickOAuth = {
  accessToken:  process.env.KICK_ACCESS_TOKEN  || '',
  refreshToken: process.env.KICK_REFRESH_TOKEN || '',
  expiresAt:    0,
  userId:       '',
  channelId:    '',
  state:        '',
  codeVerifier: '',
};

// ── Webhook raw body para verificar firma ──
app.use('/webhook/kick', express.raw({ type: '*/*' }));
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
// PKCE HELPERS
// ══════════════════════════════════════════════════════
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}
function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

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
    type: 'status',
    twitch: state.twitch.connected, kick: state.kick.connected,
    kickOAuth: state.kickOAuth.connected,
    tiktok: state.tiktok.connected, youtube: state.youtube.connected,
    youtubeVideoId: state.youtube.videoId || null,
    tiktokMode: CONFIG.tiktokMode,
    channels: { twitch: CONFIG.twitch, kick: CONFIG.kick, tiktok: CONFIG.tiktok, youtube: CONFIG.youtubeHandle }
  });
}

function htmlPage(icon, title, body, color, autoClose = false) {
  return `<html><body style="background:#0a0a0a;color:#fff;font-family:monospace;padding:60px;text-align:center">
    <div style="font-size:60px">${icon}</div>
    <h2 style="color:${color};margin:20px 0">${title}</h2>
    <p style="color:#aaa">${body}</p>
    ${autoClose ? '<script>setTimeout(()=>window.close(),3000)</script>' : ''}
  </body></html>`;
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
// KICK — PUSHER (chat normal)
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
    if (!event.startsWith('pusher') && !event.includes('ChatMessage') && !event.includes('Subscription') && !event.includes('GiftedSub') && !event.includes('ChannelPoints') && !event.includes('PointRedemption')) {
      console.log('[Kick Pusher] EVENTO DESCONOCIDO:', event, '| data:', JSON.stringify(d).slice(0, 200));
    }
    if (event === 'App\Events\ChatMessageEvent' || event === 'App.Events.ChatMessageEvent') {
      const sender = d.sender || {}, username = sender.username || 'KickUser', content = d.content || '';
      const badges = (sender.identity && sender.identity.badges) || [], nameColor = (sender.identity && sender.identity.color) || '#53FC18';
      const kickRoles = [];
      badges.forEach(b => { const bt = (b.type || '').toLowerCase(); if (bt === 'broadcaster' || bt === 'owner') kickRoles.push({ type: 'broadcaster', label: 'Owner' }); else if (bt === 'moderator' || bt === 'mod') kickRoles.push({ type: 'moderator', label: 'Mod' }); else if (bt === 'vip') kickRoles.push({ type: 'vip', label: 'VIP' }); else if (bt === 'subscriber' || bt === 'sub') kickRoles.push({ type: 'subscriber', label: 'Sub' }); else kickRoles.push({ type: bt, label: b.type }); });
      const avatarInMsg = sender.profile_pic || sender.profilePic || (sender.user && (sender.user.profile_pic || sender.user.profilePic)) || null;
      if (avatarInMsg) { kickAvatarCache[username.toLowerCase()] = avatarInMsg; broadcast({ type: 'kick', platform: 'kick', chatname: username, chatmessage: content, nameColor, chatimg: avatarInMsg, roles: kickRoles, mid: d.id || ('kick-' + Date.now()) }); }
      else { getKickAvatar(username, (avatar) => broadcast({ type: 'kick', platform: 'kick', chatname: username, chatmessage: content, nameColor, chatimg: avatar || null, roles: kickRoles, mid: d.id || ('kick-' + Date.now()) })); }
    }
    if (event === 'App\Events\ChannelPointsRedemptionEvent' || event === 'App.Events.ChannelPointsRedemptionEvent' ||
        event === 'App\Events\PointRedemptionEvent' || event === 'App.Events.PointRedemptionEvent') {
      const rdmUser = (d.user && d.user.username) || (d.sender && d.sender.username) || 'KickUser';
      const rdmTitle = (d.reward && d.reward.title) || d.reward_title || d.title || 'Recompensa';
      const rdmInput = d.message || d.comment || d.user_input || '';
      const rdmAvatar = (d.user && (d.user.profile_pic || d.user.profilePic)) || null;
      console.log(`[Kick Pusher] 🎁 Canje: "${rdmTitle}" por ${rdmUser}`);
      const sendRedeem = (av) => broadcast({ type: 'donation', platform: 'kick', donationType: 'redemption', chatname: rdmUser, chatmessage: rdmInput || '', rewardTitle: rdmTitle, chatimg: av || null, nameColor: '#53FC18', roles: [], mid: d.id || ('kick-redeem-' + Date.now()) });
      if (rdmAvatar) { kickAvatarCache[rdmUser.toLowerCase()] = rdmAvatar; sendRedeem(rdmAvatar); } else getKickAvatar(rdmUser, sendRedeem);
    }
    if (d && d.reward && d.reward.title && !event.includes('ChatMessage') && !event.includes('ChannelPoints') && !event.includes('PointRedemption') && !event.includes('Subscription') && !event.includes('GiftedSub')) {
      const rdmUserCA = (d.user && (d.user.username || d.user.login || d.user.display_name)) || (d.redeemer && d.redeemer.username) || (d.sender && d.sender.username) || 'KickUser';
      const rdmTitleCA = d.reward.title || 'Recompensa';
      const rdmInputCA = d.user_input || d.message || d.comment || '';
      const rdmAvatarCA = (d.user && (d.user.profile_pic || d.user.profilePic)) || (d.redeemer && d.redeemer.profile_picture) || null;
      console.log('[Kick Pusher] Catch-all canje: event=' + event + ' reward=' + rdmTitleCA + ' user=' + rdmUserCA);
      const sendCA = (av) => broadcast({ type: 'donation', platform: 'kick', donationType: 'redemption', chatname: rdmUserCA, chatmessage: rdmInputCA || '', rewardTitle: rdmTitleCA, chatimg: av || null, nameColor: '#53FC18', roles: [], mid: d.id || ('kick-redeem-ca-' + Date.now()) });
      if (rdmAvatarCA) { kickAvatarCache[rdmUserCA.toLowerCase()] = rdmAvatarCA; sendCA(rdmAvatarCA); } else getKickAvatar(rdmUserCA, sendCA);
    }
    if (event === 'App\Events\GiftedSubscriptionsEvent' || event === 'App.Events.GiftedSubscriptionsEvent') {
      const gifter = (d.gifted_by && d.gifted_by.username) || 'Anónimo', qty = (d.gifted_usernames && d.gifted_usernames.length) || 1;
      getKickAvatar(gifter, (avatar) => broadcast({ type: 'donation', platform: 'kick', donationType: 'giftedsub', chatname: gifter, chatmessage: `¡Regaló ${qty} sub(s)!`, amount: qty, chatimg: avatar || null, nameColor: '#53FC18', roles: [], mid: 'kick-gift-' + Date.now() }));
    }
    if (event === 'App\Events\SubscriptionEvent' || event === 'App.Events.SubscriptionEvent') {
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
// KICK OAUTH 2.1 + PKCE
// ══════════════════════════════════════════════════════
app.get('/auth/kick', (req, res) => {
  if (!CONFIG.kickClientId) {
    return res.status(500).send(htmlPage('❌', 'Falta KICK_CLIENT_ID', 'Agregá KICK_CLIENT_ID y KICK_CLIENT_SECRET en Render.', '#ff4444'));
  }
  kickOAuth.codeVerifier = generateCodeVerifier();
  kickOAuth.state        = crypto.randomBytes(16).toString('hex');
  const codeChallenge    = generateCodeChallenge(kickOAuth.codeVerifier);
  const params = new URLSearchParams({
    client_id:             CONFIG.kickClientId,
    redirect_uri:          CONFIG.kickRedirectUri,
    response_type:         'code',
    scope:                 'user:read channel:read events:subscribe channel:read:redemptions',
    state:                 kickOAuth.state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });
  res.redirect(`https://id.kick.com/oauth/authorize?${params.toString()}`);
});

app.get('/auth/kick/callback', async (req, res) => {
  const { code, state: returnedState, error } = req.query;
  if (error)                              return res.send(htmlPage('❌', 'Error OAuth', `Kick devolvió: ${error}`, '#ff4444'));
  if (returnedState !== kickOAuth.state)  return res.status(400).send(htmlPage('❌', 'State inválido', 'Intentá de nuevo.', '#ff4444'));
  if (!code)                              return res.status(400).send(htmlPage('❌', 'Sin código', 'No se recibió el código de Kick.', '#ff4444'));

  try {
    const tokenBody = new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     CONFIG.kickClientId,
      client_secret: CONFIG.kickClientSecret,
      redirect_uri:  CONFIG.kickRedirectUri,
      code_verifier: kickOAuth.codeVerifier,
      code,
    }).toString();

    const tokenRes = await httpsRequest({
      hostname: 'id.kick.com',
      path:     '/oauth/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenBody), 'Accept': 'application/json' },
    }, tokenBody);

    if (tokenRes.status !== 200 || !tokenRes.data.access_token) {
      console.error('[Kick OAuth] Error token:', JSON.stringify(tokenRes.data));
      return res.send(htmlPage('❌', 'Error al obtener token', `<pre style="text-align:left;font-size:11px;color:#aaa">${JSON.stringify(tokenRes.data, null, 2)}</pre>`, '#ff4444'));
    }

    kickOAuth.accessToken  = tokenRes.data.access_token;
    kickOAuth.refreshToken = tokenRes.data.refresh_token || '';
    kickOAuth.expiresAt    = Date.now() + ((tokenRes.data.expires_in || 3600) * 1000);
    console.log('[Kick OAuth] ✅ Token obtenido! Scopes:', tokenRes.data.scope);

    await loadKickUserInfo();
    await registerKickWebhooks();

    state.kickOAuth.connected = true;
    broadcastStatus();
    broadcast({ type: 'system', platform: 'system', chatname: 'Sistema', chatmessage: '✅ Kick OAuth conectado — Canjes de Channel Points activos 🎁', nameColor: '#53FC18', mid: 'sys-kick-' + Date.now() });

    res.send(htmlPage('✅', '¡Kick conectado!', 'Los canjes de Channel Points ya están activos.<br><br><span style="color:#666;font-size:12px">Esta ventana se cerrará en 3 segundos...</span>', '#53FC18', true));
  } catch(e) {
    console.error('[Kick OAuth] Excepción callback:', e.message);
    res.status(500).send(htmlPage('❌', 'Error interno', e.message, '#ff4444'));
  }
});

// ══════════════════════════════════════════════════════
// loadKickUserInfo con múltiples fallbacks
// ══════════════════════════════════════════════════════
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch(e) { return null; }
}

async function loadKickUserInfo() {
  const jwtPayload = decodeJwtPayload(kickOAuth.accessToken);
  if (jwtPayload) {
    console.log('[Kick OAuth] JWT payload:', JSON.stringify(jwtPayload).slice(0, 400));
    const jwtId = String(jwtPayload.sub || jwtPayload.user_id || jwtPayload.id || jwtPayload.userId || '');
    if (jwtId && jwtId !== 'undefined') {
      kickOAuth.userId    = jwtId;
      kickOAuth.channelId = jwtId;
      console.log('[Kick OAuth] userId/channelId desde JWT:', jwtId);
    }
  }

  if (!kickOAuth.channelId) {
    try {
      const r = await httpsRequest({
        hostname: 'api.kick.com',
        path:     '/public/v1/users/me',
        method:   'GET',
        headers:  { 'Authorization': `Bearer ${kickOAuth.accessToken}`, 'Accept': 'application/json' },
      });
      console.log('[Kick OAuth] /users/me status:', r.status, JSON.stringify(r.data).slice(0, 300));
      if (r.status === 200) {
        const u = (r.data && r.data.data) ? r.data.data : r.data;
        kickOAuth.userId    = String(u.user_id || u.id || u.userId || kickOAuth.userId || '');
        kickOAuth.channelId = String(u.channel_id || u.broadcaster_user_id || u.user_id || u.id || '');
        console.log('[Kick OAuth] /users/me -> userId:', kickOAuth.userId, 'channelId:', kickOAuth.channelId);
      }
    } catch(e) { console.error('[Kick OAuth] /users/me excepcion:', e.message); }
  }

  if (CONFIG.kick) {
    try {
      const channelData = await new Promise((resolve) => {
        const req = https.get(
          `https://kick.com/api/v2/channels/${CONFIG.kick.toLowerCase()}`,
          { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } },
          (res) => {
            let body = ''; res.on('data', c => body += c);
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve(null); } });
          }
        );
        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
      });
      if (channelData) {
        console.log('[Kick OAuth] kick.com/api/v2 -> user_id:', channelData.user_id, '| id:', channelData.id, '| user.id:', channelData.user && channelData.user.id);
        const apiV2Id = String(channelData.id || '');
        if (apiV2Id && apiV2Id !== 'undefined') {
          kickOAuth.channelId = apiV2Id;
          if (!kickOAuth.userId) kickOAuth.userId = apiV2Id;
          console.log('[Kick OAuth] channelId definitivo desde API v2:', kickOAuth.channelId);
        }
      }
    } catch(e) { console.error('[Kick OAuth] Excepcion API v2:', e.message); }
  }

  if (CONFIG.kickBroadcasterId) {
    kickOAuth.channelId = CONFIG.kickBroadcasterId;
    if (!kickOAuth.userId) kickOAuth.userId = CONFIG.kickBroadcasterId;
    console.log('[Kick OAuth] channelId desde KICK_BROADCASTER_ID:', kickOAuth.channelId);
  }

  if (!kickOAuth.channelId && CONFIG.kickId) {
    kickOAuth.channelId = CONFIG.kickId;
    if (!kickOAuth.userId) kickOAuth.userId = CONFIG.kickId;
    console.log('[Kick OAuth] channelId desde CONFIG.kickId:', kickOAuth.channelId);
  }

  console.log(`[Kick OAuth] FINAL -> userId: ${kickOAuth.userId || 'NULL'} | channelId: ${kickOAuth.channelId || 'NULL'}`);
  if (!kickOAuth.channelId) console.error('[Kick OAuth] Sin channelId. Webhooks no funcionaran.');
}

// ══════════════════════════════════════════════════════
// KICK WEBHOOKS — Registro y recepción
// ══════════════════════════════════════════════════════
const WEBHOOK_URL = 'https://multichat-krona-5uts.onrender.com/webhook/kick';

async function registerKickWebhooks() {
  if (!kickOAuth.accessToken) return;
  await refreshKickTokenIfNeeded();

  const broadcasterId = parseInt(kickOAuth.channelId || kickOAuth.userId);
  if (!broadcasterId) {
    console.error('[Kick Webhooks] ❌ Sin broadcaster ID — no se pueden registrar webhooks');
    return;
  }

  console.log('[Kick Webhooks] Registrando con broadcasterId:', broadcasterId);

  try {
    const listRes = await httpsRequest({
      hostname: 'api.kick.com',
      path:     '/public/v1/events/subscriptions',
      method:   'GET',
      headers:  { 'Authorization': `Bearer ${kickOAuth.accessToken}`, 'Accept': 'application/json' },
    });
    if (listRes.status === 200 && listRes.data.data && listRes.data.data.length > 0) {
      const ids = listRes.data.data.map(s => s.id).filter(Boolean);
      console.log('[Kick Webhooks] Borrando suscripciones existentes:', ids);
      if (ids.length > 0) {
        const deleteQuery = ids.map(id => `id=${id}`).join('&');
        await httpsRequest({
          hostname: 'api.kick.com',
          path:     `/public/v1/events/subscriptions?${deleteQuery}`,
          method:   'DELETE',
          headers:  { 'Authorization': `Bearer ${kickOAuth.accessToken}`, 'Accept': 'application/json' },
        });
      }
    }
  } catch(e) {
    console.log('[Kick Webhooks] No se pudieron listar/borrar suscripciones existentes:', e.message);
  }

  const body = JSON.stringify({
    events: [
      { name: 'channel.subscription.new',     version: 1 },
      { name: 'channel.subscription.renewal', version: 1 },
      { name: 'channel.subscription.gifts',   version: 1 },
      { name: 'channel.followed',              version: 1 },
      { name: 'chat.message.sent',             version: 1 },
    ],
    method:              'webhook',
    broadcaster_user_id: broadcasterId,
  });

  try {
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

    console.log('[Kick Webhooks] POST status:', r.status, JSON.stringify(r.data).slice(0, 300));

    if ([200, 201, 204].includes(r.status)) {
      state.kickOAuth.connected = true;
      broadcastStatus();
      console.log('[Kick Webhooks] ✅ Todos los eventos registrados correctamente!');
      broadcast({ type: 'system', platform: 'system', chatname: 'Sistema', chatmessage: '✅ Kick webhooks activos — canjes y subs llegando!', nameColor: '#53FC18', mid: 'sys-kick-wh-' + Date.now() });
    } else {
      console.error('[Kick Webhooks] ❌ Error:', r.status, JSON.stringify(r.data));
    }
  } catch(e) {
    console.error('[Kick Webhooks] Excepción:', e.message);
  }
}

// ══════════════════════════════════════════════════════
// ✅ FIX PRINCIPAL: Webhook handler con chat.message.sent
// ══════════════════════════════════════════════════════
app.post('/webhook/kick', (req, res) => {
  res.sendStatus(200);

  try {
    const signature  = req.headers['kick-event-signature'] || req.headers['x-kick-signature'] || '';
    const rawBody    = req.body;

    if (signature) {
      const kickPublicKey = process.env.KICK_WEBHOOK_PUBLIC_KEY || null;
      if (kickPublicKey) {
        try {
          const sigBuf = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
          const verified = crypto.verify(null, rawBody, { key: kickPublicKey, format: 'pem', type: 'spki', dsaEncoding: 'ieee-p1363' }, sigBuf);
          if (!verified) {
            console.warn('[Kick Webhook] ⚠️ Firma ED25519 inválida, procesando de todos modos (log only)');
          }
        } catch(sigErr) {
          console.warn('[Kick Webhook] ⚠️ No se pudo verificar firma:', sigErr.message);
        }
      } else {
        console.log('[Kick Webhook] ℹ️ Firma recibida pero sin clave pública configurada — procesando sin verificar');
      }
    }

    let payload;
    try { payload = JSON.parse(rawBody.toString()); } catch(e) { console.error('[Kick Webhook] Error parseando body'); return; }

    const eventType = payload.type || payload.event_type || req.headers['kick-event-type'] || req.headers['x-kick-event-type'] || '';
    const eventData = payload.data || payload.event || payload;

    console.log(`[Kick Webhook] 📨 Evento recibido: ${eventType}`);
    handleKickWebhookEvent(eventType, eventData, payload);
  } catch(e) {
    console.error('[Kick Webhook] Excepción:', e.message);
  }
});

app.get('/webhook/kick', (req, res) => {
  const challenge = req.query['hub.challenge'] || req.query.challenge;
  if (challenge) {
    console.log('[Kick Webhook] ✅ Verificación de webhook exitosa');
    return res.send(challenge);
  }
  res.json({ ok: true, endpoint: 'Kick Webhook activo' });
});

// ──────────────────────────────────────────────────────
// handleKickWebhookEvent — con el fix de chat.message.sent
// ──────────────────────────────────────────────────────
function parseKickRoles(badges) {
  const roles = [];
  (badges || []).forEach(b => {
    const bt = (b.type || '').toLowerCase();
    if (bt === 'broadcaster' || bt === 'owner') roles.push({ type: 'broadcaster', label: 'Owner' });
    else if (bt === 'moderator' || bt === 'mod') roles.push({ type: 'moderator', label: 'Mod' });
    else if (bt === 'vip')  roles.push({ type: 'vip',        label: 'VIP' });
    else if (bt === 'subscriber' || bt === 'sub') roles.push({ type: 'subscriber', label: 'Sub' });
    else roles.push({ type: bt, label: b.type });
  });
  return roles;
}

function handleKickWebhookEvent(eventType, data, rawPayload) {
  if (!data) return;
  console.log(`[Kick Webhook Event] ${eventType}:`, JSON.stringify(data).slice(0, 300));

  // ✅ FIX: Mensajes de chat via webhook (nuevo sistema de Kick)
  if (eventType === 'chat.message.sent') {
    // Kick puede envolver el mensaje en distintas estructuras — cubrir todos los casos
    const msgData    = data.message || data;
    const sender     = data.sender  || data.broadcaster || msgData.sender || {};
    const username   = sender.username    || data.username    || msgData.username    || 'KickUser';
    const content    = data.content       || msgData.content  || data.message_content || data.text || '';

    if (!content) {
      console.log('[Kick Webhook] chat.message.sent sin contenido, descartando');
      return;
    }

    const avatarInMsg = sender.profile_picture || sender.profile_pic || sender.profilePic
                     || (sender.user && (sender.user.profile_picture || sender.user.profile_pic))
                     || null;
    const nameColor   = (sender.identity && sender.identity.color) || '#53FC18';
    const badges      = (sender.identity && sender.identity.badges) || [];
    const kickRoles   = parseKickRoles(badges);
    const mid         = data.message_id || msgData.id || data.id || ('kick-wh-chat-' + Date.now());

    console.log(`[Kick Webhook] 💬 Chat: ${username}: ${content.slice(0, 80)}`);

    const send = (av) => broadcast({
      type:        'kick',
      platform:    'kick',
      chatname:    username,
      chatmessage: content,
      nameColor,
      chatimg:     av || null,
      roles:       kickRoles,
      mid,
    });

    if (avatarInMsg) {
      kickAvatarCache[username.toLowerCase()] = avatarInMsg;
      send(avatarInMsg);
    } else {
      getKickAvatar(username, send);
    }
    return;
  }

  if (eventType === 'channel.points_redemption.created' || eventType.includes('redemption')) {
    const username    = data.user?.username    || data.redeemer?.username || data.username || 'Viewer';
    const rewardTitle = data.reward?.title     || data.reward_title       || data.title    || 'Recompensa';
    const cost        = data.reward?.cost      || data.cost               || 0;
    const userMsg     = data.user_input        || data.message            || '';
    getKickAvatar(username, (avatar) => broadcast({
      type: 'donation', platform: 'kick', donationType: 'redemption',
      chatname: username, chatmessage: userMsg, rewardTitle, cost,
      chatimg: avatar || null, nameColor: '#53FC18', roles: [],
      mid: data.id || ('kick-redeem-' + Date.now())
    }));
    return;
  }

  if (eventType === 'channel.subscription.new') {
    const u = data.subscriber?.username || data.username || 'KickUser';
    getKickAvatar(u, (av) => broadcast({ type: 'donation', platform: 'kick', donationType: 'sub', chatname: u, chatmessage: '¡Se suscribió!', chatimg: av || null, nameColor: '#53FC18', roles: [], mid: 'kick-sub-wh-' + Date.now() }));
    return;
  }
  if (eventType === 'channel.subscription.renewal') {
    const u = data.subscriber?.username || data.username || 'KickUser', months = data.months || 1;
    getKickAvatar(u, (av) => broadcast({ type: 'donation', platform: 'kick', donationType: 'resub', chatname: u, chatmessage: `¡${months} mes(es)!`, months, chatimg: av || null, nameColor: '#53FC18', roles: [], mid: 'kick-resub-wh-' + Date.now() }));
    return;
  }
  if (eventType === 'channel.subscription.gifts') {
    const g = data.gifter?.username || 'Anónimo', qty = data.quantity || 1;
    getKickAvatar(g, (av) => broadcast({ type: 'donation', platform: 'kick', donationType: 'giftedsub', chatname: g, chatmessage: `¡Regaló ${qty} sub(s)!`, amount: qty, chatimg: av || null, nameColor: '#53FC18', roles: [], mid: 'kick-gift-wh-' + Date.now() }));
    return;
  }
  if (eventType === 'channel.followed') {
    const u = data.follower?.username || data.username || 'Alguien';
    getKickAvatar(u, (av) => broadcast({ type: 'donation', platform: 'kick', donationType: 'follow', chatname: u, chatmessage: '¡Siguió el canal! 💚', chatimg: av || null, nameColor: '#53FC18', roles: [], mid: 'kick-follow-wh-' + Date.now() }));
  }
}

// Refresh token automático
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
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'Accept': 'application/json' },
    }, body);
    if (r.status === 200 && r.data.access_token) {
      kickOAuth.accessToken  = r.data.access_token;
      kickOAuth.refreshToken = r.data.refresh_token || kickOAuth.refreshToken;
      kickOAuth.expiresAt    = Date.now() + ((r.data.expires_in || 3600) * 1000);
      console.log('[Kick OAuth] ✅ Token refrescado');
    } else {
      console.error('[Kick OAuth] Error refresh:', JSON.stringify(r.data));
    }
  } catch(e) {
    console.error('[Kick OAuth] Excepción refresh:', e.message);
  }
}
setInterval(refreshKickTokenIfNeeded, 30 * 60 * 1000);

app.get('/api/kick/oauth/status', (req, res) => res.json({
  connected:  state.kickOAuth.connected,
  hasToken:   !!kickOAuth.accessToken,
  userId:     kickOAuth.userId    || null,
  channelId:  kickOAuth.channelId || null,
  webhookUrl: WEBHOOK_URL,
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
  conn.on('chat',       (d) => { state.tiktok.lastMsg = Date.now(); broadcast({ type: 'tiktok', platform: 'tiktok', chatname: d.uniqueId || d.nickname || 'TikToker', chatmessage: d.comment, chatimg: d.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-' + Date.now() + '-' + Math.random() }); });
  conn.on('gift',       (d) => { state.tiktok.lastMsg = Date.now(); if (d.giftType === 1 && !d.repeatEnd) return; const gn = d.giftName || d.extendedGiftInfo?.name || `Gift #${d.giftId}`, di = d.diamondCount || 0, qty = d.repeatCount || 1; broadcast({ type: 'donation', platform: 'tiktok', donationType: 'gift', chatname: d.uniqueId || 'TikToker', chatmessage: `¡Envió ${qty}x ${gn}! (${di * qty} 💎)`, giftName: gn, amount: di * qty, currency: 'DIAMONDS', quantity: qty, chatimg: d.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-gift-' + Date.now() }); });
  conn.on('subscribe',  (d) => broadcast({ type: 'donation', platform: 'tiktok', donationType: 'sub', chatname: d.uniqueId || 'TikToker', chatmessage: '¡Se suscribió!', chatimg: d.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-sub-' + Date.now() }));
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
function rotateYouTubeApiKey() { if (YOUTUBE_API_KEYS.length <= 1) return false; ytCurrentKeyIndex = (ytCurrentKeyIndex + 1) % YOUTUBE_API_KEYS.length; return true; }

let ytPollState = { active: false, videoId: null, liveChatId: null, pageToken: null, pollTimer: null, errorCount: 0, seenIds: new Set(), keyExhaustedCount: 0 };
let ytAutoDetectTimer = null;

async function ytApiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://www.googleapis.com/youtube/v3/${path}&key=${getYouTubeApiKey()}`, { headers: { 'Accept': 'application/json' } }, (res) => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch(e) { reject(new Error('parse error')); } });
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
      if (ytPollState.seenIds.size > 1000) { const arr = Array.from(ytPollState.seenIds); ytPollState.seenIds = new Set(arr.slice(-500)); }
      const snippet = item.snippet || {}, author = item.authorDetails || {}, msgType = snippet.type || '';
      const name = author.displayName || 'YouTuber', avatar = author.profileImageUrl || null, roles = [];
      if (author.isChatOwner)     roles.push({ type: 'broadcaster', label: 'Streamer' });
      if (author.isChatModerator) roles.push({ type: 'moderator',   label: 'Mod' });
      if (author.isChatSponsor)   roles.push({ type: 'member',      label: '⭐ Miembro' });
      if (author.isVerified)      roles.push({ type: 'verified',    label: '✓' });
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
  if (ytPollState.active && ytPollState.videoId) { console.log('[YouTube] Auto-detect: live ya activo'); return; }
  const channelId = CONFIG.youtubeChannelId, handle = CONFIG.youtubeHandle.replace('@', '');
  console.log('[YouTube] Auto-detect -> channelId="' + channelId + '" handle="' + handle + '" keys=' + YOUTUBE_API_KEYS.length);
  if (!channelId && !handle) { console.log('[YouTube] Sin channelId ni handle'); return; }
  if (!getYouTubeApiKey()) { console.log('[YouTube] Sin API key'); return; }
  try {
    let searchPath;
    if (channelId) {
      searchPath = 'search?part=snippet&channelId=' + channelId + '&eventType=live&type=video&maxResults=1&order=date';
    } else {
      const rr = await ytApiGet('channels?part=id&forHandle=' + encodeURIComponent('@' + handle));
      console.log('[YouTube] Resolve handle status=' + rr.status + ' items=' + (rr.data.items && rr.data.items.length || 0));
      if (rr.status !== 200 || !rr.data.items || !rr.data.items.length) { ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, 10 * 60 * 1000); return; }
      CONFIG.youtubeChannelId = rr.data.items[0].id;
      searchPath = 'search?part=snippet&channelId=' + CONFIG.youtubeChannelId + '&eventType=live&type=video&maxResults=1&order=date';
    }
    const r = await ytApiGet(searchPath);
    const errDetail = r.status !== 200 ? JSON.stringify((r.data && r.data.error && r.data.error.message) || r.data).slice(0,200) : '';
    console.log('[YouTube] Search status=' + r.status + ' items=' + (r.data.items && r.data.items.length || 0) + (errDetail ? ' err=' + errDetail : ''));
    if (r.status === 403) {
      const reason = (r.data && r.data.error && r.data.error.errors && r.data.error.errors[0] && r.data.error.errors[0].reason) || 'quota';
      broadcast({ type: 'system', platform: 'system', chatname: 'Sistema', chatmessage: 'YouTube 403 key ' + (ytCurrentKeyIndex+1) + '/' + YOUTUBE_API_KEYS.length + ': ' + reason, nameColor: '#ff4444', mid: 'sys-yt-' + Date.now() });
      ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, 5 * 60 * 1000); return;
    }
    if (r.status !== 200 || !r.data.items || !r.data.items.length) { console.log('[YouTube] Sin live activo, reintentando en 5min'); ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, 5 * 60 * 1000); return; }
    const videoId = r.data.items[0].id && r.data.items[0].id.videoId;
    if (!videoId) { ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, 5 * 60 * 1000); return; }
    console.log('[YouTube] Live detectado: ' + videoId);
    await connectYouTubeApi(videoId);
    ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, 30 * 60 * 1000);
  } catch(e) {
    console.error('[YouTube] Auto-detect excepcion: ' + e.message);
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
  kickUserId: kickOAuth.userId || null, kickChannelId: kickOAuth.channelId || null,
  tiktok: state.tiktok.connected, youtube: state.youtube.connected, youtubeVideoId: state.youtube.videoId || null,
}));

app.get('/tiktok-preview', (req, res) => {
  const user = CONFIG.tiktok || req.query.user || '';
  res.send(`<!DOCTYPE html><html><body style="background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;flex-direction:column;gap:20px"><div style="font-size:60px">🎵</div><h2>TikTok no permite embeds</h2>${user ? `<a href="https://www.tiktok.com/@${user}/live" style="background:#FF0050;color:#fff;padding:12px 28px;border-radius:999px;text-decoration:none;font-weight:700">🔴 Ver @${user} en vivo</a>` : ''}</body></html>`);
});

app.post('/api/tiktok/restart', (req, res) => { state.tiktok.connected = false; state.tiktok.restartCount++; broadcastStatus(); connectTikTokConnector(); res.json({ ok: true }); });
app.post('/api/kick/restart',   (req, res) => { if (kickRetryTimeout) { clearTimeout(kickRetryTimeout); kickRetryTimeout = null; } state.kick.connected = false; CONFIG.kickId = process.env.KICK_CHANNEL_ID || ''; broadcastStatus(); connectKick(); res.json({ ok: true }); });

app.post('/api/kick/reregister-webhooks', async (req, res) => {
  if (!kickOAuth.accessToken) return res.status(400).json({ error: 'Sin token OAuth. Primero autorizá en /auth/kick' });
  try {
    await loadKickUserInfo();
    await registerKickWebhooks();
    res.json({ ok: true, userId: kickOAuth.userId, channelId: kickOAuth.channelId });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', (req, res) => res.json({
  twitch:    { connected: state.twitch.connected,    channel:  CONFIG.twitch },
  kick:      { connected: state.kick.connected,      channel:  CONFIG.kick },
  kickOAuth: { connected: state.kickOAuth.connected, hasToken: !!kickOAuth.accessToken, userId: kickOAuth.userId || null, channelId: kickOAuth.channelId || null, webhookUrl: WEBHOOK_URL, authUrl: '/auth/kick' },
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
  console.log(`\n🎮 MEEVE MULTICHAT SERVER v2.5`);
  console.log(`   Puerto    : ${CONFIG.port}`);
  console.log(`   Twitch    : ${CONFIG.twitch  || '(no config)'}`);
  console.log(`   Kick      : ${CONFIG.kick    || '(no config)'}`);
  console.log(`   Kick OAuth: ${CONFIG.kickClientId ? '✅ Configurado' : '❌ falta KICK_CLIENT_ID'}`);
  console.log(`   TikTok    : ${CONFIG.tiktok  || '(no config)'}`);
  console.log(`   YouTube   : ${YOUTUBE_API_KEYS.length} key(s) | ${CONFIG.youtubeChannelId || CONFIG.youtubeHandle || 'solo manual'}`);
  if (CONFIG.kickClientId) {
    console.log(`\n   👉 Activar canjes Kick:`);
    console.log(`      1. Abrí: https://multichat-krona-5uts.onrender.com/auth/kick`);
    console.log(`      2. O re-registrá webhooks: POST /api/kick/reregister-webhooks`);
    console.log(`         ${WEBHOOK_URL}\n`);
  }

  connectTwitch();
  connectKick();
  connectTikTokConnector();

  if (kickOAuth.accessToken && CONFIG.kickClientId) {
    console.log('[Kick OAuth] Token encontrado en env vars, cargando info de usuario y re-registrando webhooks...');
    kickOAuth.expiresAt = Date.now() + 3600000;
    loadKickUserInfo().then(() => {
      console.log('[Kick OAuth] Post-loadUserInfo → userId:', kickOAuth.userId, '| channelId:', kickOAuth.channelId);
      return registerKickWebhooks();
    });
    state.kickOAuth.connected = true;
  }

  if (CONFIG.youtubeChannelId || CONFIG.youtubeHandle) setTimeout(autoConnectYouTubeLive, 6000);
});
