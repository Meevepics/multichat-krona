// ============================================================
//  MEEVE MULTICHAT SERVER v2
//  ✅ Chat: Twitch + Kick + TikTok + YouTube
//  ✅ Donaciones: Twitch Bits/Subs | TikTok Gifts | Kick (browser) | YouTube SuperChats
//  ✅ Kick avatar resuelto via kick.com/api/v2
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
  youtubeHandle: process.env.YOUTUBE_HANDLE     || '',  // ← handle o nombre, ej: @Meevepics
  youtubeKey:    process.env.YOUTUBE_API_KEY    || '',  // ← API Key de YT
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

  // decapi.me devuelve directamente la URL del avatar sin auth
  const url = `https://decapi.me/twitch/avatar/${slug}`;
  console.log(`[Twitch Avatar] Resolviendo avatar para: ${slug}`);

  const req = https.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  }, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      // decapi devuelve la URL directamente como texto plano
      const avatar = body.trim().startsWith('http') ? body.trim() : null;

      if (avatar) {
        twitchAvatarCache[slug] = avatar;
        console.log(`[Twitch Avatar] ✅ ${slug} → ${avatar.substring(0, 60)}...`);
      } else {
        console.log(`[Twitch Avatar] ⚠️  No se encontró avatar para: ${slug}`);
      }

      const cbs = twitchAvatarPending[slug] || [];
      delete twitchAvatarPending[slug];
      cbs.forEach(cb => cb(avatar));
    });
  });

  req.on('error', (e) => {
    console.error(`[Twitch Avatar] Error para ${slug}:`, e.message);
    const cbs = twitchAvatarPending[slug] || [];
    delete twitchAvatarPending[slug];
    cbs.forEach(cb => cb(null));
  });

  req.setTimeout(5000, () => {
    req.destroy();
    console.warn(`[Twitch Avatar] Timeout para: ${slug}`);
    const cbs = twitchAvatarPending[slug] || [];
    delete twitchAvatarPending[slug];
    cbs.forEach(cb => cb(null));
  });
}

function getKickAvatar(username, callback) {
  if (!username) return callback(null);
  const slug = username.toLowerCase();

  if (kickAvatarCache[slug])   return callback(kickAvatarCache[slug]);
  if (kickAvatarPending[slug]) { kickAvatarPending[slug].push(callback); return; }

  kickAvatarPending[slug] = [callback];

  const url = `https://kick.com/api/v2/channels/${slug}`;
  console.log(`[Kick Avatar] Resolviendo avatar para: ${slug}`);

  const req = https.get(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    }
  }, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      let avatar = null;
      try {
        const data = JSON.parse(body);
        avatar = (data.user && (data.user.profile_pic || data.user.profilePic))
               || data.profile_pic
               || null;
      } catch(e) {}

      if (avatar) {
        kickAvatarCache[slug] = avatar;
        console.log(`[Kick Avatar] ✅ ${slug} → ${avatar.substring(0, 50)}...`);
      } else {
        console.log(`[Kick Avatar] ⚠️  No se encontró avatar para: ${slug}`);
      }

      const cbs = kickAvatarPending[slug] || [];
      delete kickAvatarPending[slug];
      cbs.forEach(cb => cb(avatar));
    });
  });

  req.on('error', (e) => {
    console.error(`[Kick Avatar] Error para ${slug}:`, e.message);
    const cbs = kickAvatarPending[slug] || [];
    delete kickAvatarPending[slug];
    cbs.forEach(cb => cb(null));
  });

  req.setTimeout(8000, () => {
    req.destroy();
    console.warn(`[Kick Avatar] Timeout para: ${slug}`);
  });
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
  console.log(`[WS] Cliente conectado. Total: ${state.clients.size}`);

  ws.send(JSON.stringify({
    type: 'status',
    twitch:  state.twitch.connected,
    kick:    state.kick.connected,
    tiktok:  state.tiktok.connected,
    youtube: state.youtube.connected,
    tiktokMode: CONFIG.tiktokMode,
    channels: { twitch: CONFIG.twitch, kick: CONFIG.kick, tiktok: CONFIG.tiktok, youtube: CONFIG.youtubeHandle }
  }));

  ws.on('close', () => {
    state.clients.delete(ws);
    console.log(`[WS] Cliente desconectado. Total: ${state.clients.size}`);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'custom_message') {
        broadcast({
          type: 'custom', platform: 'custom',
          chatname: msg.user || 'Tú',
          chatmessage: msg.text,
          nameColor: '#FF6B9D',
          mid: 'custom-' + Date.now(),
        });
      }

      // ── Mensaje destacado — enviado desde el dashboard al hacer click en un mensaje
      if (msg.type === 'highlight') {
        broadcast({
          type:        'highlight',
          platform:    msg.platform    || 'custom',
          chatname:    msg.chatname    || '',
          chatmessage: msg.chatmessage || '',
          chatimg:     msg.chatimg     || null,
          nameColor:   msg.nameColor   || '#FF6B9D',
          roles:       msg.roles       || [],
          mid:         msg.mid         || ('hl-' + Date.now()),
        });
        console.log(`[Highlight] 📌 Mensaje destacado de ${msg.chatname}: "${(msg.chatmessage||'').substring(0,60)}"`);
      }

      // ── Limpiar destacado (dashboard envía clear)
      if (msg.type === 'highlight_clear') {
        broadcast({ type: 'highlight_clear' });
        console.log('[Highlight] 🧹 Destacado limpiado');
      }

      if (msg.type === 'kick_message') {
        handleKickMessageFromBrowser(msg);
      }

      // ── Donación de Kick enviada desde el browser (ej: evento de Pusher)
      if (msg.type === 'kick_donation') {
        handleKickDonationFromBrowser(msg);
      }

      if (msg.type === 'kick_disconnected') {
        state.kick.connected = false;
        broadcastStatus();
      }

      if (msg.type === 'kick_connected') {
        state.kick.connected = true;
        broadcastStatus();
      }

    } catch(e) {}
  });
});

// ══════════════════════════════════════════════════════════════
//  TWITCH IRC + DONACIONES (Bits / Subs / Resubs / GiftSubs)
// ══════════════════════════════════════════════════════════════
function connectTwitch() {
  if (!CONFIG.twitch) return console.log('[Twitch] Sin canal configurado');

  const client = new tmi.Client({
    options: { debug: false },
    channels: [CONFIG.twitch],
  });

  client.connect().catch(err => {
    console.error('[Twitch] Error conectando:', err.message);
    setTimeout(connectTwitch, 10000);
  });

  client.on('connected', () => {
    state.twitch.connected = true;
    console.log('[Twitch] ✅ Conectado a #' + CONFIG.twitch);
    broadcastStatus();
  });

  client.on('disconnected', () => {
    state.twitch.connected = false;
    broadcastStatus();
    setTimeout(connectTwitch, 5000);
  });

  // ── Chat normal ──────────────────────────────────────────────
  client.on('message', (channel, tags, message, self) => {
    if (self) return;

    const badges = tags.badges || {};
    const roles = [];
    if (badges.broadcaster)    roles.push({ type: 'broadcaster', label: 'Streamer' });
    if (badges.moderator)      roles.push({ type: 'moderator',   label: 'Mod' });
    if (badges.vip)            roles.push({ type: 'vip',         label: 'VIP' });
    if (badges.subscriber)     roles.push({ type: 'subscriber',  label: 'Sub' });
    if (badges.founder)        roles.push({ type: 'founder',     label: 'Founder' });
    if (badges['bits-leader']) roles.push({ type: 'bits',        label: 'Bits' });

    // Detectar Bits en el mensaje (cheer100, Cheer500, etc.)
    const bitsMatch = message.match(/cheer(\d+)/i);
    const bitsAmount = tags.bits ? parseInt(tags.bits) : (bitsMatch ? parseInt(bitsMatch[1]) : 0);

    const twitchUser = tags['display-name'] || tags.username || '';
    getTwitchAvatar(twitchUser, (avatar) => {
      if (bitsAmount > 0) {
        broadcast({
          type:        'donation',
          platform:    'twitch',
          donationType: 'bits',
          chatname:    twitchUser,
          chatmessage: message.replace(/cheer\d+\s*/gi, '').trim() || `¡${bitsAmount} Bits!`,
          amount:      bitsAmount,
          currency:    'BITS',
          nameColor:   tags.color || '#9146FF',
          chatimg:     avatar || null,
          roles,
          mid:         'tw-bits-' + Date.now(),
        });
      } else {
        broadcast({
          type:        'twitch',
          platform:    'twitch',
          chatname:    twitchUser,
          chatmessage: message,
          nameColor:   tags.color || '#9146FF',
          chatimg:     avatar || null,
          roles,
          mid:         tags.id || ('tw-' + Date.now()),
        });
      }
    });
  });

  // ── Subscripción nueva ────────────────────────────────────────
  client.on('subscription', (channel, username, method, message, userstate) => {
    broadcast({
      type:        'donation',
      platform:    'twitch',
      donationType: 'sub',
      chatname:    userstate['display-name'] || username,
      chatmessage: message || '¡Nuevo suscriptor!',
      subPlan:     method?.plan || 'Prime',
      nameColor:   userstate?.color || '#9146FF',
      chatimg:     null,
      mid:         'tw-sub-' + Date.now(),
    });
    console.log(`[Twitch] 🎉 Sub: ${username}`);
  });

  // ── Re-subscripción ───────────────────────────────────────────
  client.on('resub', (channel, username, months, message, userstate, methods) => {
    broadcast({
      type:        'donation',
      platform:    'twitch',
      donationType: 'resub',
      chatname:    userstate['display-name'] || username,
      chatmessage: message || `¡${months} meses de sub!`,
      months,
      subPlan:     methods?.plan || 'Prime',
      nameColor:   userstate?.color || '#9146FF',
      chatimg:     null,
      mid:         'tw-resub-' + Date.now(),
    });
    console.log(`[Twitch] 🔄 Resub: ${username} (${months} meses)`);
  });

  // ── Sub regalo (giftsub) ──────────────────────────────────────
  client.on('subgift', (channel, username, streakMonths, recipient, methods, userstate) => {
    broadcast({
      type:        'donation',
      platform:    'twitch',
      donationType: 'subgift',
      chatname:    userstate['display-name'] || username,
      chatmessage: `¡Regaló una sub a ${recipient}!`,
      recipient,
      subPlan:     methods?.plan || '1000',
      nameColor:   userstate?.color || '#9146FF',
      chatimg:     null,
      mid:         'tw-gift-' + Date.now(),
    });
    console.log(`[Twitch] 🎁 GiftSub: ${username} → ${recipient}`);
  });

  // ── Sub regalo masivo ─────────────────────────────────────────
  client.on('submysterygift', (channel, username, numSubsGifted, methods, userstate) => {
    broadcast({
      type:        'donation',
      platform:    'twitch',
      donationType: 'subgift',
      chatname:    userstate['display-name'] || username,
      chatmessage: `¡Regaló ${numSubsGifted} subs a la comunidad!`,
      amount:      numSubsGifted,
      nameColor:   userstate?.color || '#9146FF',
      chatimg:     null,
      mid:         'tw-massgift-' + Date.now(),
    });
    console.log(`[Twitch] 🎁 Mass GiftSub: ${username} x${numSubsGifted}`);
  });
}

// ══════════════════════════════════════════════════════════════
//  KICK — Chat y Donaciones (gestionados desde el browser)
// ══════════════════════════════════════════════════════════════
app.get('/api/kick/channel-id', (req, res) => {
  res.json({ kickId: CONFIG.kickId || null, channel: CONFIG.kick });
});

app.post('/api/kick/channel-id', (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId requerido' });
  CONFIG.kickId = String(channelId);
  console.log('[Kick] Channel ID guardado:', CONFIG.kickId);
  res.json({ ok: true, kickId: CONFIG.kickId });
});

function handleKickMessageFromBrowser(data) {
  if (!data.chatname && !data.chatmessage) return;
  const username = data.chatname || 'Unknown';

  // Si el browser ya resolvió el avatar, usarlo directamente
  if (data.chatimg) {
    broadcast({
      type:        'kick',
      platform:    'kick',
      chatname:    username,
      chatmessage: data.chatmessage,
      nameColor:   data.nameColor || '#53FC18',
      chatimg:     data.chatimg,
      roles:       data.roles || [],
      mid:         data.mid || ('kick-' + Date.now()),
    });
  } else {
    // Fallback: intentar resolverlo desde el servidor
    getKickAvatar(username, (avatar) => {
      broadcast({
        type:        'kick',
        platform:    'kick',
        chatname:    username,
        chatmessage: data.chatmessage,
        nameColor:   data.nameColor || '#53FC18',
        chatimg:     avatar || null,
        roles:       data.roles || [],
        mid:         data.mid || ('kick-' + Date.now()),
      });
    });
  }
}

// Donación/Gifted sub de Kick enviada desde el browser via Pusher
function handleKickDonationFromBrowser(data) {
  const username = data.chatname || 'Unknown';
  getKickAvatar(username, (avatar) => {
    broadcast({
      type:         'donation',
      platform:     'kick',
      donationType: data.donationType || 'giftedsub', // 'giftedsub', 'sub', etc.
      chatname:     username,
      chatmessage:  data.chatmessage || '',
      amount:       data.amount || null,
      currency:     data.currency || null,
      months:       data.months || null,
      nameColor:    data.nameColor || '#53FC18',
      chatimg:      avatar || null,
      roles:        data.roles || [],
      mid:          data.mid || ('kick-don-' + Date.now()),
    });
    console.log(`[Kick] 💰 Donación de ${username}: ${data.donationType}`);
  });
}

function connectKick() {
  if (!CONFIG.kick) return console.log('[Kick] Sin canal configurado');
  console.log('[Kick] ⚠️  Conexión gestionada desde el navegador del dashboard.');
  state.kick.connected = false;
  broadcastStatus();
}

// ══════════════════════════════════════════════════════════════
//  TIKTOK — Chat + Regalos (Gifts/Donaciones)
// ══════════════════════════════════════════════════════════════
async function connectTikTokConnector() {
  if (!CONFIG.tiktok) return console.log('[TikTok] Sin usuario configurado');
  if (!WebcastPushConnection) { console.log('[TikTok] ❌ tiktok-live-connector no instalado'); return; }

  const username = CONFIG.tiktok.startsWith('@') ? CONFIG.tiktok : '@' + CONFIG.tiktok;
  console.log('[TikTok] Conectando a', username);

  if (state.tiktok.instance) {
    try { state.tiktok.instance.disconnect(); } catch(e) {}
    state.tiktok.instance = null;
  }

  const conn = new WebcastPushConnection(username, {
    processInitialData: false,
    enableExtendedGiftInfo: true,   // ← true para recibir nombre/costo del regalo
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000,
    sessionId: process.env.TIKTOK_SESSION_ID || undefined,
    requestOptions: {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }
  });

  state.tiktok.instance = conn;

  try {
    const info = await conn.connect();
    state.tiktok.connected = true;
    state.tiktok.lastMsg   = Date.now();
    console.log('[TikTok] ✅ Conectado. Room ID:', info?.roomId || 'unknown');
    broadcastStatus();
  } catch(e) {
    console.error('[TikTok] ❌ Falló:', e.message);
    broadcastStatus();
    const delay = e.message?.includes('LIVE_NOT_FOUND') ? 60000
                : e.message?.includes('429')            ? 120000
                : e.message?.includes('403')            ? 300000
                : 15000;
    setTimeout(() => connectTikTokConnector(), delay);
    return;
  }

  // ── Chat ────────────────────────────────────────────────────
  conn.on('chat', (data) => {
    state.tiktok.lastMsg = Date.now();
    broadcast({
      type:        'tiktok',
      platform:    'tiktok',
      chatname:    data.uniqueId || data.nickname || 'TikToker',
      chatmessage: data.comment,
      chatimg:     data.profilePictureUrl || null,
      nameColor:   '#FF0050',
      mid:         'tt-' + Date.now() + '-' + Math.random(),
    });
  });

  // ── Regalos/Donaciones ──────────────────────────────────────
  // giftType 1 = regalo tipo "streak" (se acumula), solo enviamos en repeatEnd
  // giftType 2 = regalo puntual (se envía directamente)
  conn.on('gift', (data) => {
    state.tiktok.lastMsg = Date.now();

    // Para regalos con streak, solo broadcastear al final del streak
    if (data.giftType === 1 && !data.repeatEnd) return;

    const giftName  = data.giftName  || data.extendedGiftInfo?.name || `Gift #${data.giftId}`;
    const giftImg   = data.giftPictureUrl || data.extendedGiftInfo?.image?.url_list?.[0] || null;
    const diamonds  = data.diamondCount || data.extendedGiftInfo?.diamond_count || 0;
    const quantity  = data.repeatCount  || 1;
    const totalDiamonds = diamonds * quantity;

    broadcast({
      type:         'donation',
      platform:     'tiktok',
      donationType: 'gift',
      chatname:     data.uniqueId || data.nickname || 'TikToker',
      chatmessage:  `¡Envió ${quantity}x ${giftName}! (${totalDiamonds} 💎)`,
      giftName,
      giftImg,
      amount:       totalDiamonds,
      currency:     'DIAMONDS',
      quantity,
      chatimg:      data.profilePictureUrl || null,
      nameColor:    '#FF0050',
      mid:          'tt-gift-' + Date.now() + '-' + Math.random(),
    });

    console.log(`[TikTok] 🎁 ${data.uniqueId} → ${quantity}x ${giftName} (${totalDiamonds}💎)`);
  });

  // ── Suscripciones de TikTok ────────────────────────────────
  conn.on('subscribe', (data) => {
    state.tiktok.lastMsg = Date.now();
    broadcast({
      type:         'donation',
      platform:     'tiktok',
      donationType: 'sub',
      chatname:     data.uniqueId || 'TikToker',
      chatmessage:  '¡Se suscribió al canal!',
      chatimg:      data.profilePictureUrl || null,
      nameColor:    '#FF0050',
      mid:          'tt-sub-' + Date.now(),
    });
    console.log(`[TikTok] 🌟 Sub: ${data.uniqueId}`);
  });

  conn.on('disconnected', () => {
    state.tiktok.connected = false;
    broadcastStatus();
    setTimeout(() => connectTikTokConnector(), 10000);
  });

  conn.on('error', (e) => console.error('[TikTok] Error:', e?.message || e));
}

// Watchdog TikTok
setInterval(() => {
  if (state.tiktok.connected && state.tiktok.lastMsg > 0 &&
      Date.now() - state.tiktok.lastMsg > 3 * 60 * 1000) {
    console.log('[TikTok] Sin mensajes por 3min, reconectando...');
    state.tiktok.connected = false;
    broadcastStatus();
    connectTikTokConnector();
  }
}, 60000);

// ══════════════════════════════════════════════════════════════
//  YOUTUBE — Chat + SuperChats via YouTube Data API v3
//  Requiere: YOUTUBE_HANDLE + YOUTUBE_API_KEY en env vars
//  Ej: YOUTUBE_HANDLE=@Meevepics  o  YOUTUBE_HANDLE=Meevepics
//
//  Flujo:
//  1) Resuelve el Channel ID desde el handle/nombre automáticamente
//  2) Busca el liveBroadcast activo del canal
//  3) Obtiene el liveChatId del broadcast
//  4) Hace polling del chat (messages + superchats)
// ══════════════════════════════════════════════════════════════
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Resuelve el Channel ID a partir de un handle (@Meevepics) o nombre de canal
async function youtubeResolveChannelId(handleOrName) {
  if (!handleOrName || !CONFIG.youtubeKey) return null;

  // Si ya es un Channel ID (empieza con UC), usarlo directamente
  if (/^UC[\w-]{22}$/.test(handleOrName)) {
    console.log('[YouTube] Channel ID directo:', handleOrName);
    return handleOrName;
  }

  // Limpiar el @ si viene con él
  const query = handleOrName.replace(/^@/, '');

  try {
    // Primero intentar con forHandle (soportado en API v3)
    const handleUrl = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${encodeURIComponent(query)}&key=${CONFIG.youtubeKey}`;
    const handleData = await fetchJSON(handleUrl);

    if (handleData.items && handleData.items.length > 0) {
      const channelId = handleData.items[0].id;
      const channelName = handleData.items[0].snippet?.title;
      console.log(`[YouTube] ✅ Canal resuelto por handle: ${channelName} → ${channelId}`);
      return channelId;
    }

    // Si no encuentra por handle, buscar por nombre
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=channel&maxResults=5&key=${CONFIG.youtubeKey}`;
    const searchData = await fetchJSON(searchUrl);

    if (searchData.items && searchData.items.length > 0) {
      const channelId = searchData.items[0].snippet?.channelId;
      const channelName = searchData.items[0].snippet?.channelTitle;
      console.log(`[YouTube] ✅ Canal resuelto por búsqueda: ${channelName} → ${channelId}`);
      return channelId;
    }

    console.log('[YouTube] ⚠️ No se encontró el canal:', handleOrName);
    return null;
  } catch(e) {
    console.error('[YouTube] Error resolviendo canal:', e.message);
    return null;
  }
}

async function youtubeGetLiveChatId(channelId) {
  if (!channelId || !CONFIG.youtubeKey) return null;

  try {
    // Buscar el video en vivo usando Search API (funciona con API key, sin OAuth)
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=live&type=video&key=${CONFIG.youtubeKey}`;
    const searchData = await fetchJSON(searchUrl);

    if (!searchData.items || searchData.items.length === 0) {
      console.log('[YouTube] No hay stream en vivo en el canal.');
      return null;
    }

    const videoId = searchData.items[0].id?.videoId;
    if (!videoId) {
      console.log('[YouTube] No se encontró videoId.');
      return null;
    }
    console.log('[YouTube] Video en vivo encontrado:', videoId);

    // Obtener el liveChatId del video
    const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${CONFIG.youtubeKey}`;
    const videoData = await fetchJSON(videoUrl);

    const chatId = videoData.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
    if (!chatId) {
      console.log('[YouTube] El video no tiene liveChatId activo.');
      return null;
    }

    console.log('[YouTube] ✅ LiveChatId encontrado:', chatId);
    return chatId;

  } catch(e) {
    console.error('[YouTube] Error obteniendo liveChatId:', e.message);
    return null;
  }
}

async function youtubePollChat() {
  if (!state.youtube.liveChatId || !CONFIG.youtubeKey) return;

  let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${state.youtube.liveChatId}&part=snippet,authorDetails&maxResults=200&key=${CONFIG.youtubeKey}`;
  if (state.youtube.nextPageToken) {
    url += `&pageToken=${encodeURIComponent(state.youtube.nextPageToken)}`;
  }

  try {
    const data = await fetchJSON(url);

    if (data.error) {
      console.error('[YouTube] API error:', data.error.message);
      if (data.error.code === 403 || data.error.code === 404) {
        // Chat terminó o no autorizado
        clearInterval(state.youtube.pollTimer);
        state.youtube.connected = false;
        state.youtube.liveChatId = null;
        broadcastStatus();
        // Reintentar buscar chat en 60s
        setTimeout(connectYouTube, 60000);
      }
      return;
    }

    state.youtube.nextPageToken = data.nextPageToken || state.youtube.nextPageToken;

    for (const item of (data.items || [])) {
      const snippet       = item.snippet || {};
      const authorDetails = item.authorDetails || {};
      const msgType       = snippet.type;

      const base = {
        chatname:  authorDetails.displayName || 'YouTuber',
        chatimg:   authorDetails.profileImageUrl || null,
        nameColor: '#FF0000',
        isOwner:   authorDetails.isChatOwner || false,
        isMod:     authorDetails.isChatModerator || false,
        isMember:  authorDetails.isChatSponsor || false,
      };

      const roles = [];
      if (base.isOwner)  roles.push({ type: 'broadcaster', label: 'Streamer' });
      if (base.isMod)    roles.push({ type: 'moderator',   label: 'Mod' });
      if (base.isMember) roles.push({ type: 'member',      label: 'Miembro' });

      if (msgType === 'textMessageEvent') {
        broadcast({
          type:        'youtube',
          platform:    'youtube',
          ...base,
          chatmessage: snippet.displayMessage || snippet.textMessageDetails?.messageText || '',
          roles,
          mid:         'yt-' + item.id,
        });

      } else if (msgType === 'superChatEvent') {
        const sc = snippet.superChatDetails || {};
        broadcast({
          type:         'donation',
          platform:     'youtube',
          donationType: 'superchat',
          ...base,
          chatmessage:  sc.userComment || '¡Super Chat!',
          amount:       sc.amountMicros ? sc.amountMicros / 1000000 : 0,
          amountDisplay: sc.amountDisplayString || '',
          currency:     sc.currency || 'USD',
          tier:         sc.tier || 1,
          roles,
          mid:          'yt-sc-' + item.id,
        });
        console.log(`[YouTube] 💰 SuperChat de ${base.chatname}: ${sc.amountDisplayString}`);

      } else if (msgType === 'superStickerEvent') {
        const ss = snippet.superStickerDetails || {};
        broadcast({
          type:         'donation',
          platform:     'youtube',
          donationType: 'supersticker',
          ...base,
          chatmessage:  ss.superStickerMetadata?.altText || '¡Super Sticker!',
          amount:       ss.amountMicros ? ss.amountMicros / 1000000 : 0,
          amountDisplay: ss.amountDisplayString || '',
          currency:     ss.currency || 'USD',
          roles,
          mid:          'yt-ss-' + item.id,
        });
        console.log(`[YouTube] 🎯 SuperSticker de ${base.chatname}: ${ss.amountDisplayString}`);

      } else if (msgType === 'memberMilestoneChatEvent' || msgType === 'newSponsorEvent') {
        const details = snippet.memberMilestoneChatDetails || snippet.newSponsorDetails || {};
        broadcast({
          type:         'donation',
          platform:     'youtube',
          donationType: 'member',
          ...base,
          chatmessage:  snippet.displayMessage || '¡Nuevo miembro!',
          months:       details.memberMonth || null,
          roles,
          mid:          'yt-mem-' + item.id,
        });
        console.log(`[YouTube] 🌟 Miembro: ${base.chatname}`);
      }
    }

    // Calcular siguiente intervalo de polling según la API
    const pollingMs = Math.max((data.pollingIntervalMillis || 5000), 3000);
    clearTimeout(state.youtube.pollTimer);
    state.youtube.pollTimer = setTimeout(youtubePollChat, pollingMs);

  } catch(e) {
    console.error('[YouTube] Error en polling:', e.message);
    clearTimeout(state.youtube.pollTimer);
    state.youtube.pollTimer = setTimeout(youtubePollChat, 10000);
  }
}

async function connectYouTube() {
  if (!CONFIG.youtubeHandle || !CONFIG.youtubeKey) {
    console.log('[YouTube] Sin canal o API key configurados (YOUTUBE_HANDLE + YOUTUBE_API_KEY)');
    return;
  }

  // Resolver Channel ID desde handle si no lo tenemos aún
  if (!state.youtube.channelId) {
    console.log('[YouTube] Resolviendo canal:', CONFIG.youtubeHandle);
    const channelId = await youtubeResolveChannelId(CONFIG.youtubeHandle);
    if (!channelId) {
      console.log('[YouTube] No se pudo resolver el canal. Reintentando en 2 min...');
      setTimeout(connectYouTube, 2 * 60 * 1000);
      return;
    }
    state.youtube.channelId = channelId;
  }

  console.log('[YouTube] Buscando broadcast activo para canal:', state.youtube.channelId);
  const chatId = await youtubeGetLiveChatId(state.youtube.channelId);

  if (!chatId) {
    // No hay live activo — reintentar en 2 minutos
    console.log('[YouTube] Sin live activo. Reintentando en 2 min...');
    setTimeout(connectYouTube, 2 * 60 * 1000);
    return;
  }

  state.youtube.liveChatId   = chatId;
  state.youtube.nextPageToken = null;
  state.youtube.connected    = true;
  broadcastStatus();

  // Primer poll
  youtubePollChat();
}

// ── HTTP ENDPOINTS ───────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  ok: true,
  uptime:   Math.floor(process.uptime()),
  messages: state.msgCount,
  clients:  state.clients.size,
  twitch:   state.twitch.connected,
  kick:     state.kick.connected,
  tiktok:   state.tiktok.connected,
  youtube:  state.youtube.connected,
  kickAvatarsCached: Object.keys(kickAvatarCache).length,
}));

app.get('/tiktok-preview', (req, res) => {
  const user = CONFIG.tiktok || req.query.user || '';
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>TikTok Preview</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#0f0f0f;color:#fff;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:20px;text-align:center;padding:20px;}a{display:inline-block;margin-top:10px;background:#FF0050;color:#fff;padding:12px 28px;border-radius:999px;text-decoration:none;font-weight:700;font-size:16px;}</style>
</head><body><div style="font-size:60px">🎵</div><h2>TikTok no permite embeds</h2>
${user ? `<a href="https://www.tiktok.com/@${user}/live" target="_blank" rel="noopener">🔴 Ver @${user} en vivo</a>` : ''}
</body></html>`);
});

app.post('/api/tiktok/restart', (req, res) => {
  state.tiktok.connected = false;
  state.tiktok.restartCount++;
  broadcastStatus();
  connectTikTokConnector();
  res.json({ ok: true, restarts: state.tiktok.restartCount });
});

app.post('/api/youtube/restart', (req, res) => {
  clearTimeout(state.youtube.pollTimer);
  state.youtube.connected    = false;
  state.youtube.liveChatId   = null;
  state.youtube.nextPageToken = null;
  state.youtube.channelId    = null;  // forzar re-resolución del canal
  broadcastStatus();
  connectYouTube();
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => res.json({
  twitch:  { connected: state.twitch.connected, channel: CONFIG.twitch },
  kick:    { connected: state.kick.connected,   channel: CONFIG.kick, kickId: CONFIG.kickId, avatarsCached: Object.keys(kickAvatarCache).length },
  tiktok:  { connected: state.tiktok.connected, user: CONFIG.tiktok, mode: CONFIG.tiktokMode, lastMsg: state.tiktok.lastMsg },
  youtube: { connected: state.youtube.connected, channelId: state.youtube.channelId || CONFIG.youtubeHandle, liveChatId: state.youtube.liveChatId },
  clients: state.clients.size,
  messages: state.msgCount,
  uptime:  Math.floor(process.uptime()),
}));

// ── ARRANCAR ─────────────────────────────────────────────────
server.listen(CONFIG.port, () => {
  console.log(`\n🎮 MEEVE MULTICHAT SERVER v2`);
  console.log(`   Puerto  : ${CONFIG.port}`);
  console.log(`   Twitch  : ${CONFIG.twitch  || '(no config)'}`);
  console.log(`   Kick    : ${CONFIG.kick    || '(no config)'}`);
  console.log(`   TikTok  : ${CONFIG.tiktok  || '(no config)'} [${CONFIG.tiktokMode}]`);
  console.log(`   YouTube : ${CONFIG.youtubeHandle || '(no config)'} ${CONFIG.youtubeKey ? '🔑' : '⚠️ Sin API key'}`);
  console.log(`   Health  : /health\n`);

  connectTwitch();
  connectKick();
  connectTikTokConnector();
  connectYouTube();
});
