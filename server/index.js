// ============================================================
//  MEEVE FULL SERVER v1.0
//  ✅ Bot de Cola de Spotify (Last.fm widget)
//  ✅ Multichat: Twitch, Kick, TikTok, YouTube
//  ✅ Widget Now Playing para OBS
//  ✅ Dashboard y Overlays
//  ✅ Admin Panel
// ============================================================

const express    = require('express');
const http       = require('http');
const https      = require('https');
const { WebSocketServer } = require('ws');
const tmi        = require('tmi.js');
const crypto     = require('crypto');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const path       = require('path');
const fetchModule = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

let WebcastPushConnection;
try {
  ({ WebcastPushConnection } = require('tiktok-live-connector'));
} catch(e) { console.log('[TikTok] tiktok-live-connector no disponible'); }

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use('/webhook/kick', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));
app.use('/overlay',   express.static(path.join(__dirname, 'overlay')));
app.get('/', (req, res) => res.redirect('/dashboard'));

// ============================================================
// CONFIG MULTICHAT
// ============================================================
const CONFIG = {
  twitch:            process.env.TWITCH_CHANNEL      || '',
  kick:              process.env.KICK_CHANNEL        || '',
  kickId:            process.env.KICK_CHANNEL_ID     || '',
  tiktok:            process.env.TIKTOK_USERNAME     || '',
  youtubeHandle:     (process.env.YOUTUBE_HANDLE     || '').trim(),
  youtubeChannelId:  (process.env.YOUTUBE_CHANNEL_ID || '').trim(),
  port:              process.env.PORT                || 3000,
  kickClientId:      process.env.KICK_CLIENT_ID      || '',
  kickClientSecret:  process.env.KICK_CLIENT_SECRET  || '',
  kickRedirectUri:   process.env.KICK_REDIRECT_URI   || '',
  kickBroadcasterId: process.env.KICK_BROADCASTER_ID || '',
};

const kickOAuth = {
  accessToken:  process.env.KICK_ACCESS_TOKEN  || '',
  refreshToken: process.env.KICK_REFRESH_TOKEN || '',
  expiresAt: 0, userId: '', channelId: '', state: '', codeVerifier: '',
};

const chatState = {
  clients: new Set(),
  tiktok:  { connected: false, lastMsg: 0, instance: null },
  twitch:  { connected: false },
  kick:    { connected: false },
  kickOAuth: { connected: false },
  youtube: { connected: false, videoId: null },
  msgCount: 0,
};

// ============================================================
// CONFIG BOT SPOTIFY
// ============================================================
const DATA_FILE = path.join(__dirname, 'data.json');
const DEFAULT_STATE = {
  songs: [], counter: 1, currentPlayingTitle: null,
  lastActivity: Date.now(), limitMode: false, limitPerUser: 3,
  kickChannel: '', kickEmotes: []
};

function loadState() {
  try { if (existsSync(DATA_FILE)) { const p = JSON.parse(readFileSync(DATA_FILE, 'utf-8')); return { ...DEFAULT_STATE, ...p }; } } catch(e) {}
  return { ...DEFAULT_STATE };
}
function saveState() { try { writeFileSync(DATA_FILE, JSON.stringify(QUEUE_STATE, null, 2), 'utf-8'); } catch(e) {} }
const QUEUE_STATE = loadState();

const DEFAULT_MESSAGES = {
  song: {
    usage:        { kick: "[emote:3404180:meevepicsno] Uso: !play nombre de la canción", twitch: "❌ Uso: !play nombre de la canción" },
    limit:        { kick: "[emote:3404180:meevepicsno] @{user} ya tienes {limit} canciones en cola.", twitch: "❌ @{user} ya tienes {limit} canciones en cola." },
    notFound:     { kick: "[emote:3404180:meevepicsno] No se encontró: \"{query}\"", twitch: "❌ No se encontró: \"{query}\"" },
    addedFirst:   { kick: "[emote:3404298:meevepicscorre] @{user} → \"{title}\" agregada como siguiente. [emote:3404182:meevepicsshhh] No se puede revocar", twitch: "✅ @{user} → \"{title}\" agregada como siguiente. ⚠️ No se puede revocar" },
    errorSpotify: { kick: "[emote:3404180:meevepicsno] Error agregando a Spotify", twitch: "❌ Error agregando a Spotify" },
    added:        { kick: "[emote:3404298:meevepicscorre] @{user} → \"{title}\" en posición {position}. Revocá con !revoke [emote:3404179:meevepicssi]", twitch: "✅ @{user} → \"{title}\" en posición {position}. Revocá con !revoke" },
    error:        { kick: "[emote:3404180:meevepicsno] Error al agregar canción", twitch: "❌ Error al agregar canción" },
  },
  revoke: {
    usage:    { kick: "[emote:3404180:meevepicsno] Uso: !revoke", twitch: "❌ Uso: !revoke" },
    empty:    { kick: "[emote:3404243:meevepicsmorfi] No hay canciones en cola", twitch: "❌ No hay canciones en cola" },
    notFound: { kick: "[emote:3404180:meevepicsno] @{user} no tenés canciones para revocar", twitch: "❌ @{user} no tenés canciones para revocar" },
    success:  { kick: "[emote:3404194:meevepicsmonstruo] @{user} → \"{title}\" revocada [emote:3404179:meevepicssi]", twitch: "✅ @{user} → \"{title}\" revocada" },
    error:    { kick: "[emote:3404180:meevepicsno] Error al revocar: {error}", twitch: "❌ Error al revocar: {error}" },
  },
  current: {
    nothing:     { kick: "[emote:3404174:meevepicspoto] No hay nada sonando", twitch: "❌ No hay nada sonando" },
    withNext:    { kick: "[emote:4872848:meevepicsbaile] Sonando: \"{title}\" → {link} | [emote:3404298:meevepicscorre] Siguiente: \"{nextTitle}\" (@{nextUser})", twitch: "🎵 Sonando: \"{title}\" → {link} | ⏭️ Siguiente: \"{nextTitle}\" (@{nextUser})" },
    withoutNext: { kick: "[emote:4872848:meevepicsbaile] Sonando: \"{title}\" → {link} | [emote:3404174:meevepicspoto] No hay siguiente", twitch: "🎵 Sonando: \"{title}\" → {link} | 🔭 No hay siguiente" },
    error:       { kick: "[emote:3404180:meevepicsno] Error obteniendo canción actual", twitch: "❌ Error obteniendo canción actual" },
  },
  mode: {
    usage: { kick: "[emote:3404180:meevepicsno] Uso: !mode on/off", twitch: "❌ Uso: !mode on/off" },
    on:    { kick: "[emote:3404179:meevepicssi] Modo límite activado. Máximo {limit} canciones.", twitch: "✅ Modo límite activado. Máximo {limit} canciones." },
    off:   { kick: "[emote:3404180:meevepicsno] Modo límite desactivado.", twitch: "❌ Modo límite desactivado." },
  },
  limit: {
    usage:       { kick: "[emote:3404180:meevepicsno] Uso: !limit [número]", twitch: "❌ Uso: !limit [número]" },
    invalid:     { kick: "[emote:3404180:meevepicsno] El límite debe ser mayor a 0", twitch: "❌ El límite debe ser mayor a 0" },
    set:         { kick: "[emote:3404179:meevepicssi] Límite configurado a {limit} canciones. {modeStatus}", twitch: "✅ Límite configurado a {limit} canciones. {modeStatus}" },
    modeActive:  { kick: "Modo límite activo [emote:3404179:meevepicssi]", twitch: "Modo límite activo ✅" },
    modeInactive:{ kick: "[emote:3404182:meevepicsshhh] Activá el modo con !mode on", twitch: "⚠️ Activá el modo con !mode on" },
  },
  skip: {
    error:       { kick: "[emote:3404180:meevepicsno] Error al saltear canción", twitch: "❌ Error al saltear canción" },
    withNext:    { kick: "[emote:3404298:meevepicscorre] Skippeada. Siguiente: \"{title}\"", twitch: "⏭️ Skippeada. Siguiente: \"{title}\"" },
    errorNext:   { kick: "[emote:3404298:meevepicscorre] Skippeada. [emote:3404180:meevepicsno] Error siguiente", twitch: "⏭️ Skippeada. Error siguiente" },
    emptyQueue:  { kick: "[emote:3404298:meevepicscorre] Skippeada. [emote:3404174:meevepicspoto] Cola vacía", twitch: "⏭️ Skippeada. Cola vacía" },
    simple:      { kick: "[emote:3404298:meevepicscorre] Canción skippeada", twitch: "⏭️ Canción skippeada" },
    genericError:{ kick: "[emote:3404180:meevepicsno] Error al saltear", twitch: "❌ Error al saltear" },
  },
  clear: {
    done: { kick: "[emote:3404194:meevepicsmonstruo] Cola limpiada ({total} canciones) [emote:3404170:meevepicszzz]", twitch: "🧹 Cola limpiada ({total} canciones)" },
  },
};

const MESSAGES_FILE = path.join(__dirname, 'messages.json');
function loadMessages() {
  try {
    if (existsSync(MESSAGES_FILE)) {
      const saved = JSON.parse(readFileSync(MESSAGES_FILE, 'utf-8'));
      for (const s of Object.keys(saved)) { if (DEFAULT_MESSAGES[s]) { for (const k of Object.keys(saved[s])) { if (DEFAULT_MESSAGES[s][k]) DEFAULT_MESSAGES[s][k] = saved[s][k]; } } }
    }
  } catch(e) {}
  return DEFAULT_MESSAGES;
}
function saveMessages() { try { writeFileSync(MESSAGES_FILE, JSON.stringify(MESSAGES, null, 2), 'utf-8'); } catch(e) {} }
const MESSAGES = loadMessages();

function msg(section, key, platform, vars = {}) {
  const isKick = platform === 'kick';
  let text = (MESSAGES[section]?.[key]?.[isKick ? 'kick' : 'twitch']) || '';
  Object.entries(vars).forEach(([k, v]) => { text = text.replaceAll(`{${k}}`, v); });
  return text;
}

// ============================================================
// SPOTIFY
// ============================================================
let spotifyToken = null, tokenExpiry = 0, monitoringInterval = null;

async function getSpotifyToken() {
  const now = Date.now();
  if (spotifyToken && now < tokenExpiry) return spotifyToken;
  try {
    const r = await fetchModule('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.SPOTIFY_REFRESH_TOKEN })
    });
    const data = await r.json();
    if (data.error) return null;
    spotifyToken = data.access_token;
    tokenExpiry = now + (data.expires_in * 1000) - 60000;
    return spotifyToken;
  } catch(e) { return null; }
}

async function addToSpotifyQueue(uri) {
  try {
    const token = await getSpotifyToken();
    const r = await fetchModule(`https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    return r.ok;
  } catch(e) { return false; }
}

async function searchSpotify(query) {
  try {
    const token = await getSpotifyToken();
    const r = await fetchModule(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (data.tracks?.items?.length > 0) {
      const track = data.tracks.items[0];
      return { title: `${track.name} - ${track.artists[0].name}`, uri: track.uri };
    }
    return null;
  } catch(e) { return null; }
}

function getQueue() { return QUEUE_STATE.songs; }
function addToQueue(song) { QUEUE_STATE.songs.push(song); QUEUE_STATE.lastActivity = Date.now(); return QUEUE_STATE.songs.length; }
function removeFirstSong() { const r = QUEUE_STATE.songs.shift(); QUEUE_STATE.lastActivity = Date.now(); return r; }
function getCounter() { return QUEUE_STATE.counter++; }
function countUserSongsInQueue(username) {
  const u = username.replace('@','').trim().toLowerCase();
  return QUEUE_STATE.songs.filter(s => !s.addedToSpotify && s.user.replace('@','').trim().toLowerCase() === u).length;
}

function startMonitoring() {
  if (monitoringInterval) return;
  monitoringInterval = setInterval(async () => {
    try {
      const queue = getQueue();
      if (queue.length === 0) { stopMonitoring(); QUEUE_STATE.currentPlayingTitle = null; return; }
      const track = await getLastFmTrack();
      if (!track || !(track['@attr']?.nowplaying === 'true')) return;
      const currentTitle = `${track.name} - ${track.artist?.['#text'] || track.artist}`;
      if (QUEUE_STATE.currentPlayingTitle && QUEUE_STATE.currentPlayingTitle !== currentTitle) {
        const first = queue[0];
        if (first?.addedToSpotify && first.title === QUEUE_STATE.currentPlayingTitle) removeFirstSong();
        const uq = getQueue();
        if (uq.length > 0) {
          const toAdd = !uq[0].addedToSpotify ? uq[0] : (uq.length > 1 && !uq[1].addedToSpotify ? uq[1] : null);
          if (toAdd) { const added = await addToSpotifyQueue(toAdd.uri); if (added) toAdd.addedToSpotify = true; }
        } else { stopMonitoring(); QUEUE_STATE.currentPlayingTitle = null; return; }
      }
      QUEUE_STATE.currentPlayingTitle = currentTitle;
    } catch(e) {}
  }, 5000);
}

function stopMonitoring() { if (monitoringInterval) { clearInterval(monitoringInterval); monitoringInterval = null; } }

// ============================================================
// LAST.FM
// ============================================================
async function getLastFmTrack() {
  const key = process.env.LASTFM_API_KEY, user = process.env.LASTFM_USER;
  if (!key || !user) return null;
  try {
    const r = await fetchModule(`https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${user}&api_key=${key}&format=json&limit=1`);
    const data = await r.json();
    const tracks = data?.recenttracks?.track;
    if (!tracks || tracks.length === 0) return null;
    return Array.isArray(tracks) ? tracks[0] : tracks;
  } catch(e) { return null; }
}

// ============================================================
// PKCE
// ============================================================
function generateCodeVerifier() { return crypto.randomBytes(32).toString('base64url'); }
function generateCodeChallenge(v) { return crypto.createHash('sha256').update(v).digest('base64url'); }

// ============================================================
// UTILIDADES MULTICHAT
// ============================================================
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
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch(e) { resolve({ status: res.statusCode, data }); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function broadcast(m) {
  const raw = JSON.stringify(m);
  chatState.clients.forEach(ws => { if (ws.readyState === 1) ws.send(raw); });
  chatState.msgCount++;
}

function broadcastStatus() {
  broadcast({ type: 'status', twitch: chatState.twitch.connected, kick: chatState.kick.connected, kickOAuth: chatState.kickOAuth.connected, tiktok: chatState.tiktok.connected, youtube: chatState.youtube.connected, youtubeVideoId: chatState.youtube.videoId || null, channels: { twitch: CONFIG.twitch, kick: CONFIG.kick, tiktok: CONFIG.tiktok, youtube: CONFIG.youtubeHandle } });
}

function htmlPage(icon, title, body, color, autoClose = false) {
  return `<html><body style="background:#0a0a0a;color:#fff;font-family:monospace;padding:60px;text-align:center"><div style="font-size:60px">${icon}</div><h2 style="color:${color};margin:20px 0">${title}</h2><p style="color:#aaa">${body}</p>${autoClose ? '<script>setTimeout(()=>window.close(),3000)</script>' : ''}</body></html>`;
}

// ============================================================
// WEBSOCKET
// ============================================================
wss.on('connection', (ws) => {
  chatState.clients.add(ws);
  ws.send(JSON.stringify({ type: 'status', twitch: chatState.twitch.connected, kick: chatState.kick.connected, kickOAuth: chatState.kickOAuth.connected, tiktok: chatState.tiktok.connected, youtube: chatState.youtube.connected, youtubeVideoId: chatState.youtube.videoId || null, channels: { twitch: CONFIG.twitch, kick: CONFIG.kick, tiktok: CONFIG.tiktok, youtube: CONFIG.youtubeHandle } }));
  ws.on('close', () => chatState.clients.delete(ws));
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data);
      if (m.type === 'custom_message') broadcast({ type: 'custom', platform: 'custom', chatname: m.user || 'Tú', chatmessage: m.text, nameColor: '#FF6B9D', mid: 'custom-' + Date.now() });
      if (m.type === 'highlight') broadcast({ type: 'highlight', platform: m.platform || 'custom', chatname: m.chatname || '', chatmessage: m.chatmessage || '', chatimg: m.chatimg || null, nameColor: m.nameColor || '#FF6B9D', roles: m.roles || [], chatemotes: m.chatemotes || [], mid: m.mid || ('hl-' + Date.now()) });
      if (m.type === 'highlight_clear') broadcast({ type: 'highlight_clear' });
      if (m.type === 'kick_message') handleKickMessageFromBrowser(m);
      if (m.type === 'kick_donation') handleKickDonationFromBrowser(m);
      if (m.type === 'kick_disconnected') { chatState.kick.connected = false; broadcastStatus(); }
      if (m.type === 'kick_connected') { chatState.kick.connected = true; broadcastStatus(); }
      if (m.type === 'youtube_connect' && m.videoId) connectYouTubeApi(m.videoId);
      if (m.type === 'youtube_disconnected') disconnectYouTubeApi();
    } catch(e) {}
  });
});

// ============================================================
// TWITCH
// ============================================================
function connectTwitch() {
  if (!CONFIG.twitch) return;
  const client = new tmi.Client({ options: { debug: false }, channels: [CONFIG.twitch] });
  client.connect().catch(() => setTimeout(connectTwitch, 10000));
  client.on('connected', () => { chatState.twitch.connected = true; broadcastStatus(); });
  client.on('disconnected', () => { chatState.twitch.connected = false; broadcastStatus(); setTimeout(connectTwitch, 5000); });
  client.on('message', (channel, tags, message, self) => {
    if (self) return;
    const badges = tags.badges || {}, roles = [];
    if (badges.broadcaster) roles.push({ type: 'broadcaster', label: 'Streamer' });
    if (badges.moderator) roles.push({ type: 'moderator', label: 'Mod' });
    if (badges.vip) roles.push({ type: 'vip', label: 'VIP' });
    if (badges.subscriber) roles.push({ type: 'subscriber', label: 'Sub' });
    const chatemotes = parseTwitchEmotes(message, tags.emotes);
    const bitsAmount = tags.bits ? parseInt(tags.bits) : 0;
    const twitchUser = tags['display-name'] || tags.username || '';
    getTwitchAvatar(twitchUser, (avatar) => {
      if (bitsAmount > 0) { broadcast({ type: 'donation', platform: 'twitch', donationType: 'bits', chatname: twitchUser, chatmessage: message.replace(/cheer\d+\s*/gi, '').trim() || `¡${bitsAmount} Bits!`, chatemotes, amount: bitsAmount, currency: 'BITS', nameColor: tags.color || '#9146FF', chatimg: avatar || null, roles, mid: 'tw-bits-' + Date.now() }); }
      else { broadcast({ type: 'twitch', platform: 'twitch', chatname: twitchUser, chatmessage: message, chatemotes, nameColor: tags.color || '#9146FF', chatimg: avatar || null, roles, mid: tags.id || ('tw-' + Date.now()) }); }
    });
  });
  client.on('subscription', (ch, u, method, msg, us) => broadcast({ type: 'donation', platform: 'twitch', donationType: 'sub', chatname: us['display-name'] || u, chatmessage: msg || '¡Nuevo suscriptor!', nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-sub-' + Date.now() }));
  client.on('resub', (ch, u, months, msg, us) => broadcast({ type: 'donation', platform: 'twitch', donationType: 'resub', chatname: us['display-name'] || u, chatmessage: msg || `¡${months} meses!`, months, nameColor: us?.color || '#9146FF', chatimg: null, mid: 'tw-resub-' + Date.now() }));
}

// ============================================================
// KICK PUSHER
// ============================================================
app.get('/api/kick/channel-id', (req, res) => res.json({ kickId: CONFIG.kickId || null, channel: CONFIG.kick }));
app.post('/api/kick/channel-id', (req, res) => { const { channelId } = req.body; if (!channelId) return res.status(400).json({ error: 'channelId requerido' }); CONFIG.kickId = String(channelId); res.json({ ok: true, kickId: CONFIG.kickId }); });

function handleKickMessageFromBrowser(data) {
  if (!data.chatname && !data.chatmessage) return;
  const username = data.chatname || 'Unknown';
  if (data.chatimg) { broadcast({ type: 'kick', platform: 'kick', chatname: username, chatmessage: data.chatmessage, nameColor: data.nameColor || '#53FC18', chatimg: data.chatimg, roles: data.roles || [], chatemotes: data.chatemotes || [], mid: data.mid || ('kick-' + Date.now()) }); }
  else { getKickAvatar(username, (avatar) => broadcast({ type: 'kick', platform: 'kick', chatname: username, chatmessage: data.chatmessage, nameColor: data.nameColor || '#53FC18', chatimg: avatar || null, roles: data.roles || [], chatemotes: data.chatemotes || [], mid: data.mid || ('kick-' + Date.now()) })); }
}

function handleKickDonationFromBrowser(data) {
  getKickAvatar(data.chatname || 'Unknown', (avatar) => broadcast({ type: 'donation', platform: 'kick', donationType: data.donationType || 'giftedsub', chatname: data.chatname || 'Unknown', chatmessage: data.chatmessage || '', amount: data.amount || null, currency: data.currency || null, months: data.months || null, rewardTitle: data.rewardTitle || null, nameColor: data.nameColor || '#53FC18', chatimg: avatar || null, roles: data.roles || [], mid: data.mid || ('kick-don-' + Date.now()) }));
}

const { WebSocket: NodeWS } = require('ws');
const PUSHER_URLS = ['wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false', 'wss://ws-us2.pusher.com/app/eb1d5f283081a78b932c?protocol=7&client=js&version=7.6.0&flash=false'];
let kickPusherWs = null, kickRetryDelay = 5000, kickRetryTimeout = null, kickUrlIndex = 0, kickPingInterval = null;

// Eventos de Pusher que ya manejamos (para filtrar el log de desconocidos)
const KNOWN_PUSHER_EVENTS = new Set([
  'App\\Events\\ChatMessageEvent',
  'App\\Events\\GiftedSubscriptionsEvent',
  'App\\Events\\SubscriptionEvent',
  'pusher:connection_established',
  'pusher:pong',
  'pusher_internal:subscription_succeeded',
  'pusher:error',
]);

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
  if (!CONFIG.kickId) { const id = await resolveKickChannelId(CONFIG.kick); if (!id) { kickRetryTimeout = setTimeout(connectKick, 60000); return; } CONFIG.kickId = id; }
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
    ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `channel.${channelId}` } }));
    kickPingInterval = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); }, 25000);
    ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `channel-points.${channelId}` } }));
    ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `redemptions.${channelId}` } }));
    ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `broadcaster.${channelId}` } }));
    console.log('[Kick Pusher] Suscrito a canales extra:', channelId);
  });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch(e) { return; }
    const event = m.event || '';
    if (event === 'pusher:connection_established' || event === 'pusher:pong') return;
    if (event === 'pusher_internal:subscription_succeeded') { chatState.kick.connected = true; broadcastStatus(); return; }
    if (event === 'pusher:error') { ws.terminate(); return; }

    let d; try { d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data; } catch(e) { return; }
    if (!d) return;

    // ── LOG: eventos desconocidos de Pusher (canjes, follows, etc.) ──────────
    if (!KNOWN_PUSHER_EVENTS.has(event)) {
      console.log('[Kick PUSHER UNKNOWN]', event, JSON.stringify(d).slice(0, 800));
    }
    // ────────────────────────────────────────────────────────────────────────

    if (event === 'App\\Events\\ChatMessageEvent' || event === 'App.Events.ChatMessageEvent') {
      const sender = d.sender || {}, username = sender.username || 'KickUser', content = d.content || '';
      const badges = (sender.identity && sender.identity.badges) || [], nameColor = (sender.identity && (sender.identity.color || sender.identity.username_color)) || '#53FC18';
      const kickRoles = []; badges.forEach(b => { const bt = (b.type || '').toLowerCase(); if (bt === 'broadcaster' || bt === 'owner') kickRoles.push({ type: 'broadcaster', label: 'Owner' }); else if (bt === 'moderator' || bt === 'mod') kickRoles.push({ type: 'moderator', label: 'Mod' }); else if (bt === 'vip') kickRoles.push({ type: 'vip', label: 'VIP' }); else if (bt === 'subscriber' || bt === 'sub') kickRoles.push({ type: 'subscriber', label: 'Sub' }); });
      const avatarInMsg = sender.profile_picture || sender.profile_pic || sender.profilePic || sender.avatar || null;
      // Detectar canjes: mensajes que empiezan con "canjeó "
      const isRedemption = /^(canjeó |canjeo |redeemed |redimió |redemption )/i.test(content);
      if (isRedemption) {
        const rewardTitle = content.replace(/^(canjeó |canjeo |redeemed |redimió |redemption )/i, '').trim();
        console.log('[Kick Redemption Pusher]', username, rewardTitle);
        const send = (av) => broadcast({ type: 'donation', platform: 'kick', donationType: 'redemption', chatname: username, chatmessage: content, rewardTitle, chatimg: av || null, nameColor: '#FFD700', roles: kickRoles, mid: d.id || ('kick-redeem-' + Date.now()) });
        if (avatarInMsg) { kickAvatarCache[username.toLowerCase()] = avatarInMsg; send(avatarInMsg); } else getKickAvatar(username, send);
      } else {
        const mid3 = d.id || ('kick-' + Date.now());
        const sendChat = (av) => broadcast({ type: 'kick', platform: 'kick', chatname: username, chatmessage: content, nameColor, chatimg: av || null, roles: kickRoles, mid: mid3 });
        if (avatarInMsg) { kickAvatarCache[username.toLowerCase()] = avatarInMsg; sendChat(avatarInMsg); }
        else if (kickAvatarCache[username.toLowerCase()]) { sendChat(kickAvatarCache[username.toLowerCase()]); }
        else { getKickAvatar(username, sendChat); }
      }
    }
    if (event === 'App\\Events\\GiftedSubscriptionsEvent') { const gifter = (d.gifted_by && d.gifted_by.username) || 'Anónimo', qty = (d.gifted_usernames && d.gifted_usernames.length) || 1; getKickAvatar(gifter, (avatar) => broadcast({ type: 'donation', platform: 'kick', donationType: 'giftedsub', chatname: gifter, chatmessage: `¡Regaló ${qty} sub(s)!`, amount: qty, chatimg: avatar || null, nameColor: '#53FC18', roles: [], mid: 'kick-gift-' + Date.now() })); }
    if (event === 'App\\Events\\SubscriptionEvent') { const uname = (d.usernames && d.usernames[0]) || d.username || 'KickUser'; getKickAvatar(uname, (avatar) => broadcast({ type: 'donation', platform: 'kick', donationType: 'sub', chatname: uname, chatmessage: '¡Se suscribió!', chatimg: avatar || null, nameColor: '#53FC18', roles: [], mid: 'kick-sub-' + Date.now() })); }
  });
  ws.on('close', () => { if (kickPingInterval) { clearInterval(kickPingInterval); kickPingInterval = null; } chatState.kick.connected = false; broadcastStatus(); kickUrlIndex++; kickRetryDelay = Math.min(kickRetryDelay * 1.5, 60000); kickRetryTimeout = setTimeout(() => tryKickPusher(channelId), kickRetryDelay); });
  ws.on('error', (e) => console.error('[Kick Pusher] WS error:', e.message));
}

// ============================================================
// KICK OAUTH
// ============================================================
app.get('/auth/kick', (req, res) => {
  if (!CONFIG.kickClientId) return res.status(500).send(htmlPage('❌', 'Falta KICK_CLIENT_ID', 'Configurá las variables de entorno.', '#ff4444'));
  kickOAuth.codeVerifier = generateCodeVerifier(); kickOAuth.state = crypto.randomBytes(16).toString('hex');
  const codeChallenge = generateCodeChallenge(kickOAuth.codeVerifier);
  const params = new URLSearchParams({ client_id: CONFIG.kickClientId, redirect_uri: CONFIG.kickRedirectUri, response_type: 'code', scope: 'user:read channel:read events:subscribe channel:read:redemptions', state: kickOAuth.state, code_challenge: codeChallenge, code_challenge_method: 'S256' });
  res.redirect(`https://id.kick.com/oauth/authorize?${params.toString()}`);
});

app.get('/auth/kick/callback', async (req, res) => {
  const { code, state: returnedState, error } = req.query;
  if (error) return res.send(htmlPage('❌', 'Error OAuth', error, '#ff4444'));
  if (returnedState !== kickOAuth.state) return res.status(400).send(htmlPage('❌', 'State inválido', 'Intentá de nuevo.', '#ff4444'));
  if (!code) return res.status(400).send(htmlPage('❌', 'Sin código', '', '#ff4444'));
  try {
    const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', client_id: CONFIG.kickClientId, client_secret: CONFIG.kickClientSecret, redirect_uri: CONFIG.kickRedirectUri, code_verifier: kickOAuth.codeVerifier, code }).toString();
    const tokenRes = await httpsRequest({ hostname: 'id.kick.com', path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenBody), 'Accept': 'application/json' } }, tokenBody);
    if (tokenRes.status !== 200 || !tokenRes.data.access_token) return res.send(htmlPage('❌', 'Error token', JSON.stringify(tokenRes.data), '#ff4444'));
    kickOAuth.accessToken = tokenRes.data.access_token; kickOAuth.refreshToken = tokenRes.data.refresh_token || ''; kickOAuth.expiresAt = Date.now() + ((tokenRes.data.expires_in || 3600) * 1000);
    await loadKickUserInfo(); await registerKickWebhooks();
    chatState.kickOAuth.connected = true; broadcastStatus();
    res.send(htmlPage('✅', '¡Kick conectado!', 'Canjes activos. Cerrando...', '#53FC18', true));
  } catch(e) { res.status(500).send(htmlPage('❌', 'Error', e.message, '#ff4444')); }
});

function decodeJwtPayload(token) { try { const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch(e) { return null; } }

async function loadKickUserInfo() {
  const jwt = decodeJwtPayload(kickOAuth.accessToken);
  if (jwt) { const jwtId = String(jwt.sub || jwt.user_id || jwt.id || ''); if (jwtId) { kickOAuth.userId = jwtId; kickOAuth.channelId = jwtId; } }
  if (CONFIG.kickBroadcasterId) { kickOAuth.channelId = CONFIG.kickBroadcasterId; if (!kickOAuth.userId) kickOAuth.userId = CONFIG.kickBroadcasterId; }
  if (!kickOAuth.channelId && CONFIG.kickId) { kickOAuth.channelId = CONFIG.kickId; if (!kickOAuth.userId) kickOAuth.userId = CONFIG.kickId; }
}

async function registerKickWebhooks() {
  if (!kickOAuth.accessToken) return;
  const broadcasterId = parseInt(kickOAuth.channelId || kickOAuth.userId);
  if (!broadcasterId) return;
  const body = JSON.stringify({
    events: [
      { name: 'channel.subscription.new', version: 1 },
      { name: 'channel.subscription.renewal', version: 1 },
      { name: 'channel.subscription.gifts', version: 1 },
      { name: 'channel.followed', version: 1 },
      { name: 'chat.message.sent', version: 1 },
      { name: 'reward-redeemed', version: 1 },
    ],
    method: 'webhook',
    broadcaster_user_id: broadcasterId,
  });
  try {
    const result = await httpsRequest({ hostname: 'api.kick.com', path: '/public/v1/events/subscriptions', method: 'POST', headers: { 'Authorization': `Bearer ${kickOAuth.accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Accept': 'application/json' } }, body);
    console.log('[Kick Webhooks] Registro resultado:', JSON.stringify(result.data).slice(0, 500));
    chatState.kickOAuth.connected = true; broadcastStatus();
  } catch(e) { console.error('[Kick Webhooks] Error al registrar:', e.message); }
}

// ============================================================
// KICK WEBHOOK
// ============================================================
app.post('/webhook/kick', (req, res) => {
  res.sendStatus(200);
  try {
    // ── LOG TEMPORAL: ver todo lo que llega al webhook ───────────────────────
    console.log('[Kick Webhook HEADERS]', JSON.stringify({
      'kick-event-type': req.headers['kick-event-type'],
      'kick-event-version': req.headers['kick-event-version'],
      'content-type': req.headers['content-type'],
    }));
    console.log('[Kick Webhook BODY]', req.body.toString().slice(0, 1000));
    // ────────────────────────────────────────────────────────────────────────

    let payload; try { payload = JSON.parse(req.body.toString()); } catch(e) { return; }
    const eventType = payload.type || payload.event_type || req.headers['kick-event-type'] || '';
    handleKickWebhookEvent(eventType, payload.data || payload.event || payload);
  } catch(e) {}
});
app.get('/webhook/kick', (req, res) => { const c = req.query['hub.challenge'] || req.query.challenge; if (c) return res.send(c); res.json({ ok: true }); });

function parseKickRoles(badges) {
  const roles = []; (badges || []).forEach(b => { const bt = (b.type || '').toLowerCase(); if (bt === 'broadcaster' || bt === 'owner') roles.push({ type: 'broadcaster', label: 'Owner' }); else if (bt === 'moderator' || bt === 'mod') roles.push({ type: 'moderator', label: 'Mod' }); else if (bt === 'vip') roles.push({ type: 'vip', label: 'VIP' }); else if (bt === 'subscriber' || bt === 'sub') roles.push({ type: 'subscriber', label: 'Sub' }); }); return roles;
}

function handleKickWebhookEvent(eventType, data) {
  if (!data) return;

  // ── LOG: eventos de webhook no reconocidos ───────────────────────────────
  const KNOWN_WEBHOOK_EVENTS = ['chat.message.sent', 'channel.subscription.new', 'channel.subscription.renewal', 'channel.subscription.gifts', 'channel.followed',   'reward-redeemed'];
  if (eventType && !KNOWN_WEBHOOK_EVENTS.includes(eventType)) {
    console.log('[Kick Webhook UNKNOWN EVENT]', eventType, JSON.stringify(data).slice(0, 800));
  }
  // ────────────────────────────────────────────────────────────────────────

  if (eventType === 'chat.message.sent') {
    const sender = data.sender || {}, username = sender.username || data.username || 'KickUser', content = data.content || data.message_content || '';
    if (!content) return;
    const avatarInMsg = sender.profile_picture || sender.profile_pic || sender.profilePic || sender.avatar || null;
    const nameColor = (sender.identity && (sender.identity.username_color || sender.identity.color)) || '#53FC18';
    const kickRoles = parseKickRoles(sender.identity?.badges);
    const mid = data.message_id || data.id || ('kick-wh-' + Date.now());
    // Detectar canjes: mensajes que empiezan con "canjeó "
    const isRedemption = /^(canjeó |canjeo |redeemed |redimió |redemption )/i.test(content);
    if (isRedemption) {
      const rewardTitle = content.replace(/^(canjeó |canjeo |redeemed |redimió |redemption )/i, '').trim();
      console.log('[Kick Redemption Webhook]', username, rewardTitle);
      const send = (av) => broadcast({ type: 'donation', platform: 'kick', donationType: 'redemption', chatname: username, chatmessage: content, rewardTitle, chatimg: av || null, nameColor: '#FFD700', roles: kickRoles, mid });
      if (avatarInMsg) { kickAvatarCache[username.toLowerCase()] = avatarInMsg; send(avatarInMsg); } else getKickAvatar(username, send);
    } else {
      const send = (av) => broadcast({ type: 'kick', platform: 'kick', chatname: username, chatmessage: content, nameColor, chatimg: av || null, roles: kickRoles, mid });
      if (avatarInMsg) { kickAvatarCache[username.toLowerCase()] = avatarInMsg; send(avatarInMsg); } else getKickAvatar(username, send);
    }
    return;
  }
  if (eventType === 'channel.subscription.new') { const u = data.subscriber?.username || 'KickUser'; getKickAvatar(u, (av) => broadcast({ type: 'donation', platform: 'kick', donationType: 'sub', chatname: u, chatmessage: '¡Se suscribió!', chatimg: av || null, nameColor: '#53FC18', roles: [], mid: 'kick-sub-wh-' + Date.now() })); }
  if (eventType === 'channel.subscription.renewal') { const u = data.subscriber?.username || 'KickUser', months = data.months || 1; getKickAvatar(u, (av) => broadcast({ type: 'donation', platform: 'kick', donationType: 'resub', chatname: u, chatmessage: `¡${months} mes(es)!`, months, chatimg: av || null, nameColor: '#53FC18', roles: [], mid: 'kick-resub-wh-' + Date.now() })); }
  if (eventType === 'channel.subscription.gifts') { const g = data.gifter?.username || 'Anónimo', qty = data.quantity || 1; getKickAvatar(g, (av) => broadcast({ type: 'donation', platform: 'kick', donationType: 'giftedsub', chatname: g, chatmessage: `¡Regaló ${qty} sub(s)!`, amount: qty, chatimg: av || null, nameColor: '#53FC18', roles: [], mid: 'kick-gift-wh-' + Date.now() })); }
  if (eventType === 'channel.followed') { const u = data.follower?.username || 'Alguien'; getKickAvatar(u, (av) => broadcast({ type: 'donation', platform: 'kick', donationType: 'follow', chatname: u, chatmessage: '¡Siguió el canal! 💚', chatimg: av || null, nameColor: '#53FC18', roles: [], mid: 'kick-follow-wh-' + Date.now() })); }

  // ── CANJES DE CHANNEL POINTS ─────────────────────────────────────────────
  if (eventType === 'reward-redeemed') {
    // Kick payload: { type: 'reward-redeemed', data: { redemption: { user, reward, user_input } } }
    const redemption = data.redemption || data;
    const username = redemption.user?.display_name || redemption.user?.login || redemption.user?.username || data.user?.display_name || 'KickUser';
    const rewardTitle = redemption.reward?.title || data.reward?.title || 'Canje';
    const cost = redemption.reward?.cost || data.reward?.cost || null;
    const userInput = redemption.user_input || data.user_input || '';
    const chatmessage = userInput
      ? `canjeó "${rewardTitle}" → ${userInput}`
      : `canjeó "${rewardTitle}"${cost ? ` (${cost} pts)` : ''}`;
    console.log('[Kick Redemption]', username, rewardTitle, cost);
    getKickAvatar(username, (av) => broadcast({
      type: 'donation',
      platform: 'kick',
      donationType: 'redemption',
      chatname: username,
      chatmessage,
      rewardTitle,
      amount: cost,
      chatimg: av || null,
      nameColor: '#FFD700',
      roles: [],
      mid: 'kick-redeem-' + (redemption.id || Date.now()),
    }));
  }
  // ────────────────────────────────────────────────────────────────────────
}

async function refreshKickTokenIfNeeded() {
  if (!kickOAuth.refreshToken || kickOAuth.expiresAt > Date.now() + 60000) return;
  try {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: CONFIG.kickClientId, client_secret: CONFIG.kickClientSecret, refresh_token: kickOAuth.refreshToken }).toString();
    const r = await httpsRequest({ hostname: 'id.kick.com', path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'Accept': 'application/json' } }, body);
    if (r.status === 200 && r.data.access_token) { kickOAuth.accessToken = r.data.access_token; kickOAuth.refreshToken = r.data.refresh_token || kickOAuth.refreshToken; kickOAuth.expiresAt = Date.now() + ((r.data.expires_in || 3600) * 1000); }
  } catch(e) {}
}
setInterval(refreshKickTokenIfNeeded, 30 * 60 * 1000);

// ============================================================
// TIKTOK
// ============================================================
async function connectTikTokConnector() {
  if (!CONFIG.tiktok || !WebcastPushConnection) return;
  const username = CONFIG.tiktok.startsWith('@') ? CONFIG.tiktok : '@' + CONFIG.tiktok;
  if (chatState.tiktok.instance) { try { chatState.tiktok.instance.disconnect(); } catch(e) {} chatState.tiktok.instance = null; }
  const conn = new WebcastPushConnection(username, { processInitialData: false, enableExtendedGiftInfo: true, enableWebsocketUpgrade: true, requestPollingIntervalMs: 2000 });
  chatState.tiktok.instance = conn;
  try { await conn.connect(); chatState.tiktok.connected = true; chatState.tiktok.lastMsg = Date.now(); broadcastStatus(); }
  catch(e) { broadcastStatus(); setTimeout(() => connectTikTokConnector(), e.message?.includes('LIVE_NOT_FOUND') ? 60000 : 15000); return; }
  conn.on('chat', (d) => { chatState.tiktok.lastMsg = Date.now(); broadcast({ type: 'tiktok', platform: 'tiktok', chatname: d.uniqueId || d.nickname || 'TikToker', chatmessage: d.comment, chatimg: d.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-' + Date.now() + '-' + Math.random() }); });
  conn.on('gift', (d) => { if (d.giftType === 1 && !d.repeatEnd) return; const gn = d.giftName || `Gift #${d.giftId}`, di = d.diamondCount || 0, qty = d.repeatCount || 1; broadcast({ type: 'donation', platform: 'tiktok', donationType: 'gift', chatname: d.uniqueId || 'TikToker', chatmessage: `¡Envió ${qty}x ${gn}! (${di * qty} 💎)`, giftName: gn, amount: di * qty, currency: 'DIAMONDS', quantity: qty, chatimg: d.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-gift-' + Date.now() }); });
  conn.on('subscribe', (d) => broadcast({ type: 'donation', platform: 'tiktok', donationType: 'sub', chatname: d.uniqueId || 'TikToker', chatmessage: '¡Se suscribió!', chatimg: d.profilePictureUrl || null, nameColor: '#FF0050', mid: 'tt-sub-' + Date.now() }));
  conn.on('disconnected', () => { chatState.tiktok.connected = false; broadcastStatus(); setTimeout(() => connectTikTokConnector(), 10000); });
  conn.on('error', (e) => console.error('[TikTok] Error:', e?.message || e));
}

// ============================================================
// YOUTUBE
// ============================================================
const YOUTUBE_API_KEYS = (() => { const keys = []; for (let i = 1; i <= 4; i++) { const k = process.env[i === 1 ? 'YOUTUBE_API_KEY' : `YOUTUBE_API_KEY_${i}`]; if (k) keys.push(k); } return keys.filter(Boolean); })();
let ytCurrentKeyIndex = 0;
function getYouTubeApiKey() { return YOUTUBE_API_KEYS[ytCurrentKeyIndex] || ''; }
function rotateYouTubeApiKey() { if (YOUTUBE_API_KEYS.length <= 1) return false; ytCurrentKeyIndex = (ytCurrentKeyIndex + 1) % YOUTUBE_API_KEYS.length; return true; }
let ytPollState = { active: false, liveChatId: null, pageToken: null, pollTimer: null, errorCount: 0, seenIds: new Set() };
let ytAutoDetectTimer = null;

async function ytApiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://www.googleapis.com/youtube/v3/${path}&key=${getYouTubeApiKey()}`, { headers: { 'Accept': 'application/json' } }, (res) => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch(e) { reject(new Error('parse error')); } });
    });
    req.on('error', reject); req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getLiveChatId(videoId) {
  const r = await ytApiGet(`videos?part=liveStreamingDetails&id=${videoId}`);
  if (r.status !== 200) throw new Error(`API error ${r.status}`);
  const details = r.data.items?.[0]?.liveStreamingDetails;
  if (!details?.activeLiveChatId) throw new Error('Sin chat en vivo activo');
  return details.activeLiveChatId;
}

async function pollYouTubeChat() {
  if (!ytPollState.active || !ytPollState.liveChatId || !getYouTubeApiKey()) return;
  try {
    let path = `liveChat/messages?part=snippet,authorDetails&liveChatId=${ytPollState.liveChatId}&maxResults=200`;
    if (ytPollState.pageToken) path += `&pageToken=${ytPollState.pageToken}`;
    const r = await ytApiGet(path);
    if (r.status === 403) { if (!rotateYouTubeApiKey()) { chatState.youtube.connected = false; broadcastStatus(); ytPollState.active = false; return; } if (ytPollState.active) ytPollState.pollTimer = setTimeout(pollYouTubeChat, 1000); return; }
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    ytPollState.errorCount = 0;
    if (r.data.nextPageToken) ytPollState.pageToken = r.data.nextPageToken;
    (r.data.items || []).forEach(item => {
      const id = item.id; if (!id || ytPollState.seenIds.has(id)) return;
      ytPollState.seenIds.add(id);
      const snippet = item.snippet || {}, author = item.authorDetails || {}, msgType = snippet.type || '';
      const name = author.displayName || 'YouTuber', avatar = author.profileImageUrl || null, roles = [];
      if (author.isChatOwner) roles.push({ type: 'broadcaster', label: 'Streamer' });
      if (author.isChatModerator) roles.push({ type: 'moderator', label: 'Mod' });
      if (author.isChatSponsor) roles.push({ type: 'member', label: '⭐ Miembro' });
      if (msgType === 'superChatEvent') { const sc = snippet.superChatDetails || {}; broadcast({ type: 'donation', platform: 'youtube', donationType: 'superchat', chatname: name, chatmessage: sc.userComment || '¡Superchat!', chatimg: avatar, nameColor: '#FF0000', amount: (sc.amountMicros || 0) / 1000000, amountDisplay: sc.amountDisplayString || '', roles, mid: 'yt-sc-' + id }); return; }
      if (msgType === 'textMessageEvent') { const t = snippet.textMessageDetails?.messageText || ''; if (!t) return; broadcast({ type: 'youtube', platform: 'youtube', chatname: name, chatmessage: t, chatimg: avatar, nameColor: '#FF0000', roles, mid: 'yt-' + id }); }
    });
    const interval = Math.max((r.data.pollingIntervalMillis || 5000), 3000);
    if (ytPollState.active) ytPollState.pollTimer = setTimeout(pollYouTubeChat, interval);
  } catch(e) { ytPollState.errorCount++; if (ytPollState.errorCount > 5) { chatState.youtube.connected = false; ytPollState.active = false; broadcastStatus(); return; } if (ytPollState.active) ytPollState.pollTimer = setTimeout(pollYouTubeChat, 15000); }
}

async function connectYouTubeApi(videoId) {
  if (ytPollState.pollTimer) { clearTimeout(ytPollState.pollTimer); ytPollState.pollTimer = null; }
  ytPollState.active = false; ytPollState.pageToken = null; ytPollState.errorCount = 0;
  if (!YOUTUBE_API_KEYS.length) return;
  ytCurrentKeyIndex = 0; chatState.youtube.videoId = videoId;
  try {
    const liveChatId = await getLiveChatId(videoId);
    ytPollState.liveChatId = liveChatId; ytPollState.videoId = videoId; ytPollState.active = true;
    chatState.youtube.connected = true; chatState.youtube.videoId = videoId; broadcastStatus();
    ytPollState.pollTimer = setTimeout(pollYouTubeChat, 2000);
  } catch(e) { chatState.youtube.connected = false; chatState.youtube.videoId = null; broadcastStatus(); }
}

function disconnectYouTubeApi() {
  ytPollState.active = false;
  if (ytPollState.pollTimer) { clearTimeout(ytPollState.pollTimer); ytPollState.pollTimer = null; }
  if (ytAutoDetectTimer) { clearTimeout(ytAutoDetectTimer); ytAutoDetectTimer = null; }
  ytPollState.liveChatId = null; ytPollState.pageToken = null; ytPollState.videoId = null;
  chatState.youtube.connected = false; chatState.youtube.videoId = null; broadcastStatus();
}

// Extrae video ID de cualquier formato de URL de YouTube
function extractYouTubeVideoId(input) {
  if (!input) return null;
  input = input.trim();
  // Si ya es un ID puro (11 chars alfanuméricos)
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  // youtu.be/ID
  const short = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (short) return short[1];
  // youtube.com/watch?v=ID
  const watch = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (watch) return watch[1];
  // youtube.com/live/ID
  const live = input.match(/\/live\/([a-zA-Z0-9_-]{11})/);
  if (live) return live[1];
  // youtube.com/embed/ID
  const embed = input.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
  if (embed) return embed[1];
  return null;
}

let ytAutoDetectRetries = 0;

async function autoConnectYouTubeLive() {
  if (ytAutoDetectTimer) { clearTimeout(ytAutoDetectTimer); ytAutoDetectTimer = null; }
  if (ytPollState.active && ytPollState.videoId) return;
  const channelId = CONFIG.youtubeChannelId, handle = CONFIG.youtubeHandle.replace('@', '');
  if (!channelId && !handle) return;
  if (!getYouTubeApiKey()) return;

  // Reintentar más seguido al inicio (primeros 10 intentos cada 1 min, luego cada 5 min)
  ytAutoDetectRetries++;
  const retryDelay = ytAutoDetectRetries <= 10 ? 60 * 1000 : 5 * 60 * 1000;

  try {
    let searchPath;
    if (channelId) {
      searchPath = 'search?part=snippet&channelId=' + channelId + '&eventType=live&type=video&maxResults=3&order=date';
    } else {
      // Intentar resolver el channelId desde el handle
      const rr = await ytApiGet('channels?part=id&forHandle=' + encodeURIComponent('@' + handle));
      if (rr.status !== 200 || !rr.data.items?.length) {
        // Intentar también sin @ por si acaso
        const rr2 = await ytApiGet('channels?part=id&forUsername=' + encodeURIComponent(handle));
        if (rr2.status !== 200 || !rr2.data.items?.length) {
          console.log('[YouTube AutoDetect] No se pudo resolver channelId para:', handle, '— reintentando en', retryDelay/1000, 's');
          ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, retryDelay);
          return;
        }
        CONFIG.youtubeChannelId = rr2.data.items[0].id;
      } else {
        CONFIG.youtubeChannelId = rr.data.items[0].id;
      }
      searchPath = 'search?part=snippet&channelId=' + CONFIG.youtubeChannelId + '&eventType=live&type=video&maxResults=3&order=date';
    }

    const r = await ytApiGet(searchPath);
    if (r.status === 403) {
      console.log('[YouTube AutoDetect] API key agotada, rotando...');
      rotateYouTubeApiKey();
      ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, 10000);
      return;
    }
    if (r.status !== 200 || !r.data.items?.length) {
      console.log('[YouTube AutoDetect] Sin live detectado — reintentando en', retryDelay/1000, 's');
      ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, retryDelay);
      return;
    }

    const videoId = r.data.items[0].id?.videoId;
    if (!videoId) {
      ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, retryDelay);
      return;
    }

    console.log('[YouTube AutoDetect] Live encontrado:', videoId, '— conectando...');
    ytAutoDetectRetries = 0;
    await connectYouTubeApi(videoId);
    // Una vez conectado, recheck cada 30 min por si se cae
    ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, 30 * 60 * 1000);
  } catch(e) {
    console.log('[YouTube AutoDetect] Error:', e.message, '— reintentando en', retryDelay/1000, 's');
    ytAutoDetectTimer = setTimeout(autoConnectYouTubeLive, retryDelay);
  }
}

// ============================================================
// ENDPOINTS BOT SPOTIFY
// ============================================================
app.get('/status', (req, res) => { const queue = getQueue(); res.json({ status: 'online', queue: queue.length, monitoring: monitoringInterval !== null, currentTrack: QUEUE_STATE.currentPlayingTitle, limitMode: QUEUE_STATE.limitMode, limitPerUser: QUEUE_STATE.limitPerUser }); });

app.get('/widget', (req, res) => { try { const html = readFileSync(path.join(__dirname, 'spotify.html'), 'utf-8'); res.setHeader('Content-Type', 'text/html'); res.send(html); } catch(e) { res.status(500).send('No se encontró spotify.html'); } });

app.get('/nowplaying', async (req, res) => {
  try {
    const track = await getLastFmTrack();
    if (!track) return res.json({ status: 'stopped', track: null, isPlaying: false, progressMs: 0, durationMs: 0, receivedAt: Date.now() });
    const isPlaying = !!(track['@attr']?.nowplaying === 'true');
    const images = track.image || [], imageUrl = (images[images.length - 1] || {})['#text'] || '', duration = (parseInt(track.duration) || 0) * 1000;
    const queue = getQueue(), nextSong = queue.find(s => !s.addedToSpotify) || queue[1] || null;
    res.json({ status: isPlaying ? 'playing' : 'paused', isPlaying, track: { name: track.name || '', artist: track.artist?.['#text'] || track.artist || '', album: track.album?.['#text'] || track.album || '', imageUrl }, progressMs: 0, durationMs: duration, receivedAt: Date.now(), queue: { total: queue.length, next: nextSong ? { title: nextSong.title, user: nextSong.user } : null } });
  } catch(e) { res.status(500).json({ status: 'error', error: e.message }); }
});

app.get('/song', async (req, res) => {
  try {
    const { query, user, platform } = req.query;
    if (!query) return res.send(msg('song', 'usage', platform));
    if (QUEUE_STATE.limitMode && countUserSongsInQueue(user) >= QUEUE_STATE.limitPerUser) return res.send(msg('song', 'limit', platform, { user, limit: QUEUE_STATE.limitPerUser }));
    const songData = await searchSpotify(query);
    if (!songData) return res.send(msg('song', 'notFound', platform, { query }));
    const newSong = { id: getCounter(), title: songData.title, uri: songData.uri, user: user || 'Anónimo', addedAt: new Date().toISOString(), addedToSpotify: false };
    const position = addToQueue(newSong);
    if (position === 1) {
      const added = await addToSpotifyQueue(newSong.uri);
      if (added) { newSong.addedToSpotify = true; startMonitoring(); return res.send(msg('song', 'addedFirst', platform, { user, title: songData.title })); }
      return res.send(msg('song', 'errorSpotify', platform));
    }
    res.send(msg('song', 'added', platform, { user, title: songData.title, position }));
  } catch(e) { res.send(msg('song', 'error', req.query.platform)); }
});

app.get('/revoke', (req, res) => {
  try {
    const { user, platform } = req.query;
    if (!user) return res.send(msg('revoke', 'usage', platform));
    const queue = getQueue();
    if (queue.length === 0) return res.send(msg('revoke', 'empty', platform));
    const normalizedUser = user.replace('@', '').trim().toLowerCase();
    let songIndex = -1;
    for (let i = queue.length - 1; i >= 0; i--) { if (queue[i].user.replace('@', '').trim().toLowerCase() === normalizedUser && !queue[i].addedToSpotify) { songIndex = i; break; } }
    if (songIndex === -1) return res.send(msg('revoke', 'notFound', platform, { user }));
    const song = queue[songIndex]; QUEUE_STATE.songs.splice(songIndex, 1); QUEUE_STATE.lastActivity = Date.now();
    res.send(msg('revoke', 'success', platform, { user, title: song.title }));
  } catch(e) { res.send(msg('revoke', 'error', req.query.platform, { error: e.message })); }
});

app.get('/current', async (req, res) => {
  try {
    const { platform } = req.query;
    const track = await getLastFmTrack();
    if (!track || !(track['@attr']?.nowplaying === 'true')) return res.send(msg('current', 'nothing', platform));
    const title = `${track.name} - ${track.artist?.['#text'] || track.artist}`, link = track.url || '';
    const queue = getQueue(), nextSong = queue.find(s => s.title !== title) || null;
    if (nextSong) return res.send(msg('current', 'withNext', platform, { title, link, nextTitle: nextSong.title, nextUser: nextSong.user }));
    return res.send(msg('current', 'withoutNext', platform, { title, link }));
  } catch(e) { res.send(msg('current', 'error', req.query.platform)); }
});

app.get('/queue', (req, res) => { const queue = getQueue(); res.json({ current: QUEUE_STATE.currentPlayingTitle, queue, total: queue.length, limitMode: QUEUE_STATE.limitMode, limitPerUser: QUEUE_STATE.limitPerUser }); });

app.get('/mode', (req, res) => { const { query, platform } = req.query; if (!query) return res.send(msg('mode', 'usage', platform)); const m = query.toLowerCase().trim(); if (m === 'on') { QUEUE_STATE.limitMode = true; saveState(); return res.send(msg('mode', 'on', platform, { limit: QUEUE_STATE.limitPerUser })); } if (m === 'off') { QUEUE_STATE.limitMode = false; saveState(); return res.send(msg('mode', 'off', platform)); } res.send(msg('mode', 'usage', platform)); });

app.get('/limit', (req, res) => { const { query, platform } = req.query; if (!query) return res.send(msg('limit', 'usage', platform)); const limit = parseInt(query); if (isNaN(limit) || limit < 1) return res.send(msg('limit', 'invalid', platform)); QUEUE_STATE.limitPerUser = limit; saveState(); const modeStatus = msg('limit', QUEUE_STATE.limitMode ? 'modeActive' : 'modeInactive', platform); res.send(msg('limit', 'set', platform, { limit, modeStatus })); });

app.get('/skip', async (req, res) => {
  try {
    const { platform } = req.query;
    const token = await getSpotifyToken();
    const skipResponse = await fetchModule('https://api.spotify.com/v1/me/player/next', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (!skipResponse.ok && skipResponse.status !== 204) return res.send(msg('skip', 'error', platform));
    const queue = getQueue();
    if (queue.length > 0 && queue[0].addedToSpotify) {
      removeFirstSong();
      const uq = getQueue();
      if (uq.length > 0) { const nextSong = uq[0]; const added = await addToSpotifyQueue(nextSong.uri); if (added) { nextSong.addedToSpotify = true; return res.send(msg('skip', 'withNext', platform, { title: nextSong.title })); } return res.send(msg('skip', 'errorNext', platform)); }
      else { stopMonitoring(); return res.send(msg('skip', 'emptyQueue', platform)); }
    }
    res.send(msg('skip', 'simple', platform));
  } catch(e) { res.send(msg('skip', 'genericError', req.query.platform)); }
});

app.get('/clear', (req, res) => { const { platform } = req.query; const total = QUEUE_STATE.songs.length; QUEUE_STATE.songs = []; QUEUE_STATE.currentPlayingTitle = null; stopMonitoring(); res.send(msg('clear', 'done', platform, { total })); });

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('Error: no se recibió código');
  try {
    const r = await fetchModule('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')}` }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.SPOTIFY_REDIRECT_URI }) });
    const data = await r.json();
    res.send(`<h1>✅ Refresh Token</h1><pre style="background:#f4f4f4;padding:15px;">${data.refresh_token}</pre>`);
  } catch(e) { res.send(`Error: ${e.message}`); }
});

// ============================================================
// ENDPOINTS MULTICHAT
// ============================================================
app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()), messages: chatState.msgCount, clients: chatState.clients.size, twitch: chatState.twitch.connected, kick: chatState.kick.connected, kickOAuth: chatState.kickOAuth.connected, tiktok: chatState.tiktok.connected, youtube: chatState.youtube.connected }));

app.get('/api/status', (req, res) => res.json({ twitch: { connected: chatState.twitch.connected, channel: CONFIG.twitch }, kick: { connected: chatState.kick.connected, channel: CONFIG.kick }, kickOAuth: { connected: chatState.kickOAuth.connected, hasToken: !!kickOAuth.accessToken }, tiktok: { connected: chatState.tiktok.connected, user: CONFIG.tiktok }, youtube: { connected: chatState.youtube.connected, videoId: chatState.youtube.videoId, handle: CONFIG.youtubeHandle }, clients: chatState.clients.size, messages: chatState.msgCount }));

app.post('/api/kick/restart', (req, res) => { if (kickRetryTimeout) { clearTimeout(kickRetryTimeout); kickRetryTimeout = null; } chatState.kick.connected = false; CONFIG.kickId = process.env.KICK_CHANNEL_ID || ''; broadcastStatus(); connectKick(); res.json({ ok: true }); });
app.post('/api/tiktok/restart', (req, res) => { chatState.tiktok.connected = false; broadcastStatus(); connectTikTokConnector(); res.json({ ok: true }); });
app.post('/api/youtube/connect', (req, res) => {
  // Acepta videoId directo o URL completa de YouTube
  const raw = req.body.videoId || req.body.url || req.body.link || '';
  if (!raw) return res.status(400).json({ error: 'videoId o url requerido' });
  const videoId = extractYouTubeVideoId(raw) || raw.trim();
  if (!videoId) return res.status(400).json({ error: 'No se pudo extraer el video ID' });
  ytAutoDetectRetries = 0;
  connectYouTubeApi(videoId);
  res.json({ ok: true, videoId });
});

// GET para conectar desde el browser fácilmente
// Ej: /api/youtube/connect?url=https://youtube.com/watch?v=XXXX
app.get('/api/youtube/connect', (req, res) => {
  const raw = req.query.videoId || req.query.url || req.query.link || '';
  if (!raw) return res.status(400).json({ error: 'videoId o url requerido' });
  const videoId = extractYouTubeVideoId(raw) || raw.trim();
  if (!videoId) return res.status(400).json({ error: 'No se pudo extraer el video ID' });
  ytAutoDetectRetries = 0;
  connectYouTubeApi(videoId);
  res.json({ ok: true, videoId });
});
app.post('/api/youtube/disconnect', (req, res) => { disconnectYouTubeApi(); res.json({ ok: true }); });
app.post('/api/kick/reregister-webhooks', async (req, res) => { if (!kickOAuth.accessToken) return res.status(400).json({ error: 'Sin token OAuth' }); try { await loadKickUserInfo(); await registerKickWebhooks(); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); } });

app.post('/api/kick/set-token', async (req, res) => {
  const { accessToken, refreshToken } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'accessToken requerido' });
  kickOAuth.accessToken = accessToken;
  kickOAuth.refreshToken = refreshToken || '';
  kickOAuth.expiresAt = Date.now() + 3600000;
  await loadKickUserInfo();
  await registerKickWebhooks();
  chatState.kickOAuth.connected = true;
  broadcastStatus();
  console.log('[Kick OAuth] Token seteado manualmente, channelId:', kickOAuth.channelId);
  res.json({ ok: true, channelId: kickOAuth.channelId, userId: kickOAuth.userId });
});

// ============================================================
// ENDPOINT CANJES TOUCH PORTAL / EXTERNOS
// ============================================================
app.post('/api/kick/redemption', (req, res) => {
  // Acepta cualquier combinación de campos que mande Touch Portal
  const username = req.body.username || req.body.user || req.body.viewer || req.body.sender || 'KickUser';
  const rewardTitle = req.body.rewardTitle || req.body.reward || req.body.title || req.body.rewardName || req.body.reward_title || 'Canje';
  const userInput = req.body.userInput || req.body.input || req.body.message || req.body.user_input || '';
  const cost = req.body.cost || req.body.points || null;
  const chatmessage = userInput
    ? `canjeó "${rewardTitle}" → ${userInput}`
    : `canjeó "${rewardTitle}"${cost ? ` (${cost} pts)` : ''}`;
  console.log('[Kick Redemption TouchPortal]', username, rewardTitle, userInput);
  getKickAvatar(username, (av) => broadcast({
    type: 'donation',
    platform: 'kick',
    donationType: 'redemption',
    chatname: username,
    chatmessage,
    rewardTitle,
    amount: cost || null,
    chatimg: av || null,
    nameColor: '#FFD700',
    roles: [],
    mid: 'kick-redeem-tp-' + Date.now(),
  }));
  res.json({ ok: true, username, rewardTitle, userInput });
});

// También acepta GET para facilitar integración con herramientas simples
app.get('/api/kick/redemption', (req, res) => {
  const username = req.query.username || req.query.user || req.query.viewer || 'KickUser';
  const rewardTitle = req.query.rewardTitle || req.query.reward || req.query.title || req.query.rewardName || 'Canje';
  const userInput = req.query.userInput || req.query.input || req.query.message || '';
  const cost = req.query.cost || req.query.points || null;
  const chatmessage = userInput
    ? `canjeó "${rewardTitle}" → ${userInput}`
    : `canjeó "${rewardTitle}"${cost ? ` (${cost} pts)` : ''}`;
  console.log('[Kick Redemption GET]', username, rewardTitle, userInput);
  getKickAvatar(username, (av) => broadcast({
    type: 'donation',
    platform: 'kick',
    donationType: 'redemption',
    chatname: username,
    chatmessage,
    rewardTitle,
    amount: cost || null,
    chatimg: av || null,
    nameColor: '#FFD700',
    roles: [],
    mid: 'kick-redeem-get-' + Date.now(),
  }));
  res.json({ ok: true, username, rewardTitle, userInput });
});

// ============================================================
// ADMIN PANEL
// ============================================================
app.get('/admin/emotes', (req, res) => res.json(QUEUE_STATE.kickEmotes || []));
app.delete('/admin/emotes/:id', (req, res) => { const { adminKey } = req.body; if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ ok: false, error: 'No autorizado' }); const before = QUEUE_STATE.kickEmotes.length; QUEUE_STATE.kickEmotes = QUEUE_STATE.kickEmotes.filter(e => e.id !== req.params.id); saveState(); res.json({ ok: true, removed: before - QUEUE_STATE.kickEmotes.length }); });
app.post('/admin/emotes/bulk', (req, res) => { const { adminKey, text } = req.body; if ((adminKey || req.headers['x-admin-key'] || '') !== process.env.ADMIN_KEY) return res.status(403).json({ ok: false, error: 'No autorizado' }); if (!text) return res.status(400).json({ ok: false, error: 'Se requiere texto' }); const matches = [...text.matchAll(/\[emote:(\d+):([^\]]+)\]/g)]; const added = [], dupes = []; for (const m of matches) { const id = m[1], name = m[2].trim(); if (QUEUE_STATE.kickEmotes.some(e => e.id === id)) { dupes.push(name); } else { QUEUE_STATE.kickEmotes.push({ id, name }); added.push(name); } } saveState(); res.json({ ok: true, added: added.length, dupes: dupes.length, total: QUEUE_STATE.kickEmotes.length }); });
app.get('/admin/messages', (req, res) => res.json(MESSAGES));
app.post('/admin/messages', (req, res) => { const { adminKey, section, key, platform, value } = req.body; if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ ok: false, error: 'Clave incorrecta' }); if (!MESSAGES[section]?.[key] || !['kick', 'twitch'].includes(platform)) return res.status(400).json({ ok: false, error: 'Parámetros inválidos' }); MESSAGES[section][key][platform] = value; saveMessages(); res.json({ ok: true }); });

// ============================================================
// ARRANQUE
// ============================================================
const PORT = CONFIG.port;
server.listen(PORT, () => {
  console.log(`\n🎮 MEEVE FULL SERVER v1.0`);
  console.log(`   Puerto    : ${PORT}`);
  console.log(`   Twitch    : ${CONFIG.twitch || '(no config)'}`);
  console.log(`   Kick      : ${CONFIG.kick || '(no config)'}`);
  console.log(`   TikTok    : ${CONFIG.tiktok || '(no config)'}`);
  console.log(`   YouTube   : ${YOUTUBE_API_KEYS.length} key(s)`);
  console.log(`   Last.fm   : ${process.env.LASTFM_USER || '(no config)'}`);
  console.log(`   Spotify   : ${process.env.SPOTIFY_CLIENT_ID ? '✅' : '❌'}`);
  connectTwitch();
  connectKick();
  connectTikTokConnector();
  if (kickOAuth.accessToken && CONFIG.kickClientId) { kickOAuth.expiresAt = Date.now() + 3600000; loadKickUserInfo().then(() => registerKickWebhooks()); chatState.kickOAuth.connected = true; }
  if (CONFIG.youtubeChannelId || CONFIG.youtubeHandle) setTimeout(autoConnectYouTubeLive, 6000);
});
