// ============================================================
//  MEEVE MULTICHAT SERVER v2 — FIXED
//  ✅ Chat: Twitch + Kick + TikTok + YouTube
//  ✅ Donaciones: Twitch Bits/Subs | TikTok Gifts | Kick (browser) | YouTube SuperChats
//  ✅ Kick avatar resuelto via kick.com/api/v2
//  ✅ FIXED: Twitch emotes → chatemotes [{text,url,start,end}]
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
  twitch:       process.env.TWITCH_CHANNEL    || '',
  kick:         process.env.KICK_CHANNEL      || '',
  kickId:       process.env.KICK_CHANNEL_ID   || '',
  tiktok:       process.env.TIKTOK_USERNAME   || '',
  youtubeHandle: process.env.YOUTUBE_HANDLE     || '',
  youtubeKey:    process.env.YOUTUBE_API_KEY    || '',
  port:         process.env.PORT              || 3000,
  tiktokMode:   process.env.TIKTOK_MODE       || 'connector',
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
  youtube:  { connected: false, channelId: null, liveChatId: null, nextPageToken: null, pollTimer: null },
  msgCount: 0,
};

// ══════════════════════════════════════════════════════════════
// ★ NUEVA FUNCIÓN: Parsear emotes de Twitch
//   tmi.js entrega tags.emotes como:
//   { '25': ['0-4', '12-16'], '1902': ['6-10'] }
//   Lo convertimos a: [{ text, url, start, end }]
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
  // Ordenar por posición
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

      if (msg.type === 'kick_message') handleKickMessageFromBrowser(msg);
      if (msg.type === 'kick_donation') handleKickDonationFromBrowser(msg);
      if (msg.type === 'kick_disconnected') { state.kick.connected = false; broadcastStatus(); }
      if (msg.type === 'kick_connected') { state.kick.connected = true; broadcastStatus(); }
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

    // ★ PARSEAR EMOTES DE TWITCH
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
          chatemotes,   // ← INCLUIR EMOTES
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

function connectKick() {
  if (!CONFIG.kick) return;
  state.kick.connected = false;
  broadcastStatus();
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
    const info = await conn.connect();
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

async function youtubeResolveChannelId(handleOrName) {
  if (!handleOrName || !CONFIG.youtubeKey) return null;
  if (/^UC[\w-]{22}$/.test(handleOrName)) return handleOrName;
  const query = handleOrName.replace(/^@/, '');
  try {
    const handleData = await fetchJSON(`https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${encodeURIComponent(query)}&key=${CONFIG.youtubeKey}`);
    if (handleData.items?.length > 0) return handleData.items[0].id;
    const searchData = await fetchJSON(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=channel&maxResults=5&key=${CONFIG.youtubeKey}`);
    if (searchData.items?.length > 0) return searchData.items[0].snippet?.channelId;
    return null;
  } catch(e) { return null; }
}

async function youtubeGetLiveChatId(channelId) {
  if (!channelId || !CONFIG.youtubeKey) return null;
  try {
    const searchData = await fetchJSON(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=live&type=video&key=${CONFIG.youtubeKey}`);
    if (!searchData.items?.length) return null;
    const videoId = searchData.items[0].id?.videoId;
    if (!videoId) return null;
    const videoData = await fetchJSON(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${CONFIG.youtubeKey}`);
    return videoData.items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
  } catch(e) { return null; }
}

async function youtubePollChat() {
  if (!state.youtube.liveChatId || !CONFIG.youtubeKey) return;
  let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${state.youtube.liveChatId}&part=snippet,authorDetails&maxResults=200&key=${CONFIG.youtubeKey}`;
  if (state.youtube.nextPageToken) url += `&pageToken=${encodeURIComponent(state.youtube.nextPageToken)}`;

  try {
    const data = await fetchJSON(url);
    if (data.error) {
      if (data.error.code === 403 || data.error.code === 404) {
        clearInterval(state.youtube.pollTimer);
        state.youtube.connected = false; state.youtube.liveChatId = null;
        broadcastStatus();
        setTimeout(connectYouTube, 60000);
      }
      return;
    }
    state.youtube.nextPageToken = data.nextPageToken || state.youtube.nextPageToken;

    for (const item of (data.items || [])) {
      const snippet = item.snippet || {};
      const authorDetails = item.authorDetails || {};
      const msgType = snippet.type;
      const base = { chatname: authorDetails.displayName || 'YouTuber', chatimg: authorDetails.profileImageUrl || null, nameColor: '#FF0000', isOwner: authorDetails.isChatOwner || false, isMod: authorDetails.isChatModerator || false, isMember: authorDetails.isChatSponsor || false };
      const roles = [];
      if (base.isOwner) roles.push({ type: 'broadcaster', label: 'Streamer' });
      if (base.isMod)   roles.push({ type: 'moderator', label: 'Mod' });
      if (base.isMember) roles.push({ type: 'member', label: 'Miembro' });

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
    clearTimeout(state.youtube.pollTimer);
    state.youtube.pollTimer = setTimeout(youtubePollChat, 10000);
  }
}

async function connectYouTube() {
  if (!CONFIG.youtubeHandle || !CONFIG.youtubeKey) return;
  if (!state.youtube.channelId) {
    const channelId = await youtubeResolveChannelId(CONFIG.youtubeHandle);
    if (!channelId) { setTimeout(connectYouTube, 2 * 60 * 1000); return; }
    state.youtube.channelId = channelId;
  }
  const chatId = await youtubeGetLiveChatId(state.youtube.channelId);
  if (!chatId) { setTimeout(connectYouTube, 2 * 60 * 1000); return; }
  state.youtube.liveChatId = chatId;
  state.youtube.nextPageToken = null;
  state.youtube.connected = true;
  broadcastStatus();
  youtubePollChat();
}

// ── HTTP ENDPOINTS ───────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()), messages: state.msgCount, clients: state.clients.size, twitch: state.twitch.connected, kick: state.kick.connected, tiktok: state.tiktok.connected, youtube: state.youtube.connected }));

app.get('/tiktok-preview', (req, res) => {
  const user = CONFIG.tiktok || req.query.user || '';
  res.send(`<!DOCTYPE html><html><body style="background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;flex-direction:column;gap:20px"><div style="font-size:60px">🎵</div><h2>TikTok no permite embeds</h2>${user?`<a href="https://www.tiktok.com/@${user}/live" style="background:#FF0050;color:#fff;padding:12px 28px;border-radius:999px;text-decoration:none;font-weight:700">🔴 Ver @${user} en vivo</a>`:''}</body></html>`);
});

app.post('/api/tiktok/restart', (req, res) => {
  state.tiktok.connected = false; state.tiktok.restartCount++;
  broadcastStatus(); connectTikTokConnector();
  res.json({ ok: true, restarts: state.tiktok.restartCount });
});

app.post('/api/youtube/restart', (req, res) => {
  clearTimeout(state.youtube.pollTimer);
  state.youtube.connected = false; state.youtube.liveChatId = null;
  state.youtube.nextPageToken = null; state.youtube.channelId = null;
  broadcastStatus(); connectYouTube();
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => res.json({
  twitch: { connected: state.twitch.connected, channel: CONFIG.twitch },
  kick: { connected: state.kick.connected, channel: CONFIG.kick },
  tiktok: { connected: state.tiktok.connected, user: CONFIG.tiktok },
  youtube: { connected: state.youtube.connected, channelId: state.youtube.channelId || CONFIG.youtubeHandle },
  clients: state.clients.size, messages: state.msgCount, uptime: Math.floor(process.uptime()),
}));

// ── ARRANCAR ─────────────────────────────────────────────────
server.listen(CONFIG.port, () => {
  console.log(`\n🎮 MEEVE MULTICHAT SERVER v2 — FIXED`);
  console.log(`   Puerto  : ${CONFIG.port}`);
  console.log(`   Twitch  : ${CONFIG.twitch || '(no config)'}`);
  console.log(`   Kick    : ${CONFIG.kick || '(no config)'}`);
  console.log(`   TikTok  : ${CONFIG.tiktok || '(no config)'}`);
  console.log(`   YouTube : ${CONFIG.youtubeHandle || '(no config)'}\n`);
  connectTwitch();
  connectKick();
  connectTikTokConnector();
  connectYouTube();
});
