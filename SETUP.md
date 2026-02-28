# 🎮 Meeve Multichat — Guía Completa de Configuración

Todo lo que necesitás saber para armar el sistema desde cero.

---

## ¿Qué es esto?

Un servidor Node.js que conecta el chat de **Twitch, Kick, TikTok y YouTube** en un solo overlay para OBS. Incluye donaciones, bits, subs, gifted subs, SuperChats y regalos de TikTok.

### Arquitectura general

```
Twitch ──────────────────────────┐
TikTok ──────────────────────────┤
YouTube (polling API) ───────────┤──► Servidor Node.js (Render/Railway)
                                 │         │
Kick ──► Dashboard (browser) ────┘         │ WebSocket
                                           │
                                    Overlay HTML (OBS)
                                    Dashboard HTML (tú)
```

Kick es especial: su chat se lee **desde tu navegador** (en el dashboard) porque los servidores en la nube quedan bloqueados por Kick. El browser actúa como puente.

---

## Estructura del repositorio

```
multichat/
├── server/
│   ├── index.js          ← servidor principal
│   └── package.json      ← dependencias Node.js
├── dashboard/
│   └── index.html        ← panel de control (vos lo usás)
├── overlay/
│   └── index.html        ← lo que va en OBS como fuente de navegador
└── SETUP.md              ← esta guía
```

---

## PASO 1 — Crear el repositorio en GitHub

1. Entrá a [github.com](https://github.com) e iniciá sesión
2. **New repository** → nombre: `multichat` → **Public** → **Create**
3. Subí todos los archivos respetando la estructura de carpetas de arriba
4. Verificá que `server/index.js` y `server/package.json` estén en la carpeta `server/`

---

## PASO 2 — Deploy del servidor en Render

Render es gratuito y sirve perfectamente para esto.

1. Entrá a [render.com](https://render.com) y creá una cuenta (podés usar tu cuenta de GitHub)
2. **New +** → **Web Service**
3. Conectá tu repositorio de GitHub (`multichat`)
4. Configurá así:
   - **Name**: `multichat` (o como quieras)
   - **Root Directory**: `server`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
   - **Instance Type**: Free
5. Clic en **Create Web Service**

Render te va a dar una URL como `https://multichat-xxxx.onrender.com` — **guardala**, la vas a usar en todo.

> ⚠️ El plan gratuito de Render "duerme" el servidor después de 15 minutos sin uso. Para evitarlo usá UptimeRobot (ver Paso 6).

---

## PASO 3 — Variables de entorno en Render

En tu servicio de Render, andá a **Environment** y agregá estas variables:

| Variable | Valor | Descripción |
|---|---|---|
| `TWITCH_CHANNEL` | `meevepics` | Tu nombre de usuario en Twitch (sin #) |
| `KICK_CHANNEL` | `meevepics` | Tu nombre de usuario en Kick |
| `TIKTOK_USERNAME` | `meevepics` | Tu usuario de TikTok (sin @) |
| `YOUTUBE_HANDLE` | `@Meevepics` | Tu handle de YouTube (con o sin @) |
| `YOUTUBE_API_KEY` | `AIzaSy...` | Tu API Key de Google (ver Paso 4) |

### Variables opcionales

| Variable | Valor | Cuándo usarla |
|---|---|---|
| `TIKTOK_SESSION_ID` | `(valor de cookie)` | Si TikTok te da error 403 (ver sección TikTok) |
| `TIKTOK_MODE` | `connector` | Dejalo en `connector` siempre |

Después de agregar las variables, Render reinicia el servidor automáticamente.

---

## PASO 4 — Obtener la API Key de YouTube

Necesitás esto para que YouTube funcione. Es gratis.

### Crear la API Key

1. Entrá a [console.cloud.google.com](https://console.cloud.google.com)
2. Arriba a la izquierda, clic en el selector de proyectos → **Nuevo proyecto**
   - Nombre: `meeve-multichat` → **Crear**
3. Menú ☰ → **APIs y servicios** → **Biblioteca**
4. Buscá `YouTube Data API v3` → clic → **Habilitar**
5. Menú ☰ → **APIs y servicios** → **Credenciales**
6. **+ Crear credenciales** → **Clave de API**
7. Te aparece la key: `AIzaSyXXXXXXXXXXXXXXXXX` — **copiala ahora**

### (Opcional) Restringir la key por seguridad

En la key recién creada → **Restringir clave** → en "Restricciones de API" → **Restringir clave** → seleccioná **YouTube Data API v3** → Guardar.

### Límites gratuitos

- 10.000 unidades/día gratis
- El servidor usa ~5-10 unidades por poll (cada 5 segundos)
- Alcanza perfectamente para cualquier stream

### Cómo funciona YouTube en el servidor

El servidor **no necesita que le des el Channel ID** — lo resuelve solo:

1. Usás `YOUTUBE_HANDLE=@Meevepics` en las variables
2. Al arrancar, el servidor hace una búsqueda por handle y obtiene el Channel ID automáticamente
3. Cuando estás en vivo, lo detecta y conecta al chat
4. Si no estás en vivo, reintenta cada 2 minutos

---

## PASO 5 — Configurar el Dashboard

El dashboard es el archivo `dashboard/index.html`. Lo abrís directo desde GitHub Pages o desde tu computadora.

### Conectar al servidor

1. Abrí el dashboard en tu navegador
2. En el campo **"URL del servidor"** pegá la URL de Render:
   ```
   https://multichat-xxxx.onrender.com
   ```
3. Clic en **Conectar**
4. El punto al lado de "Conectado" se pone verde

### Kick — Resolver el ID del chatroom

Kick requiere un paso extra porque el chat se maneja desde el browser:

1. En la card **"Kick — Resolver ID"** clic en **🔍 Resolver automático**
2. El dashboard hace la búsqueda solo y conecta
3. Si falla, usá **✏️ Manual** e ingresá el número de chatroom ID
   - Para encontrarlo: andá a `kick.com/tucanal` → F12 → Network → buscá una request que contenga `chatrooms.XXXXXXX`

El ID se guarda en el navegador, no lo tenés que ingresar cada vez.

### YouTube — Conectar cuando estás en vivo

1. Cuando empieces un stream en YouTube, clic en **🔄 Reconectar ahora** en la card de YouTube
2. El servidor busca el live activo y conecta al instante
3. El punto de YouTube se pone verde

Si no apretás el botón, el servidor igual detecta el live solo en hasta 2 minutos.

### TikTok

- El botón **🔄 Reconectar** fuerza una reconexión si TikTok se desconecta
- El botón **📺 Abrir Live** abre tu live de TikTok en una nueva pestaña
- Si ves el error `LIVE has ended` y sí estás en vivo → usá el Session ID (ver abajo)

---

## PASO 6 — Overlay en OBS

El overlay es el archivo `overlay/index.html` publicado en GitHub Pages.

### Activar GitHub Pages

1. En tu repo de GitHub → **Settings** → **Pages**
2. **Source**: Deploy from branch → branch `main` → carpeta `/` (root) → **Save**
3. En unos minutos tu overlay va a estar en:
   ```
   https://tuusuario.github.io/multichat/overlay/index.html
   ```

### Agregar a OBS

1. En OBS → **+** → **Fuente de navegador**
2. **URL**:
   ```
   https://tuusuario.github.io/multichat/overlay/index.html?server=https://multichat-xxxx.onrender.com
   ```
3. **Ancho**: 400 / **Alto**: 800 (ajustá según tu diseño)
4. ✅ **Actualizar el navegador cuando la escena se active**

> El dashboard tiene un botón **📋 Copiar URL OBS** que arma esta URL automáticamente.

---

## PASO 7 — Mantener el servidor activo (UptimeRobot)

Render en plan gratuito duerme el servidor si no recibe requests en 15 minutos. UptimeRobot lo mantiene despierto gratis.

1. Entrá a [uptimerobot.com](https://uptimerobot.com) y creá una cuenta
2. **Add New Monitor**:
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: `Meeve Multichat`
   - **URL**: `https://multichat-xxxx.onrender.com/health`
   - **Monitoring Interval**: 5 minutes
3. **Create Monitor**

Listo — el servidor va a estar siempre despierto.

---

## Solución de problemas

### TikTok da error 403

TikTok a veces bloquea las conexiones desde servidores en la nube. La solución es darle tu Session ID:

1. Abrí [tiktok.com](https://tiktok.com) en Chrome e iniciá sesión
2. F12 → pestaña **Application** → **Cookies** → `https://www.tiktok.com`
3. Buscá la cookie `sessionid` y copiá el valor
4. En Render → Environment → agregá:
   ```
   TIKTOK_SESSION_ID = (el valor copiado)
   ```
5. Reiniciá el servidor

> ⚠️ El sessionid caduca cada ~30 días. Si TikTok vuelve a fallar, repetí el proceso.

### YouTube no conecta aunque estoy en vivo

1. Verificá que `YOUTUBE_HANDLE` y `YOUTUBE_API_KEY` estén bien en Render
2. Apretá **🔄 Reconectar ahora** en el dashboard
3. Mirá los logs en Render — debería aparecer:
   ```
   [YouTube] ✅ Canal resuelto por handle: Meevepics → UCZ6IMb...
   [YouTube] Video en vivo encontrado: xxxxxxxxxxxx
   [YouTube] ✅ LiveChatId encontrado: Ciq...
   ```
4. Si dice `403` en los logs, la API Key puede estar mal configurada o sin la YouTube Data API v3 habilitada

### Kick no muestra mensajes

- Verificá que el punto de Kick esté verde en el dashboard
- Si está rojo, clic en **🔍 Resolver automático** de nuevo
- El dashboard tiene que estar abierto mientras streameas — es el que mantiene la conexión a Kick

### Kick no muestra fotos de perfil

Las fotos de Kick se resuelven desde tu navegador (el dashboard). Si el dashboard está abierto, deberían aparecer. Si no, verificá que no haya errores de CORS en la consola (F12).

### Twitch no muestra fotos de perfil

El servidor las resuelve via [decapi.me](https://decapi.me). Si no aparecen, es posible que decapi.me esté caído — es un servicio externo gratuito. No hay solución inmediata más que esperar.

### El servidor no arranca en Render

Revisá los logs en Render → tu servicio → **Logs**. Los errores más comunes son:
- `Cannot find module 'tmi.js'` → faltó el `npm install`, verificá que el **Root Directory** sea `server`
- `Port already in use` → no debería pasar en Render, Render asigna el puerto via `PORT`

---

## Variables de entorno — Resumen completo

```env
# Obligatorias
TWITCH_CHANNEL=meevepics
KICK_CHANNEL=meevepics
TIKTOK_USERNAME=meevepics
YOUTUBE_HANDLE=@Meevepics
YOUTUBE_API_KEY=AIzaSy...

# Opcionales
TIKTOK_SESSION_ID=      # Solo si TikTok da error 403
TIKTOK_MODE=connector   # No tocar
```

---

## Endpoints del servidor

| Endpoint | Método | Descripción |
|---|---|---|
| `/health` | GET | Estado del servidor y todas las conexiones |
| `/api/status` | GET | Estado detallado en JSON |
| `/api/tiktok/restart` | POST | Fuerza reconexión de TikTok |
| `/api/youtube/restart` | POST | Fuerza reconexión de YouTube |
| `/api/kick/channel-id` | POST | Recibe el chatroom ID de Kick desde el dashboard |

---

## Flujo de mensajes

```
Twitch  →  tmi.js (IRC)          →  broadcast() WebSocket  →  Overlay OBS
TikTok  →  tiktok-live-connector →  broadcast() WebSocket  →  Overlay OBS
YouTube →  polling API v3        →  broadcast() WebSocket  →  Overlay OBS
Kick    →  Pusher (browser)      →  WS al servidor         →  broadcast() WebSocket  →  Overlay OBS
```

### Formato de mensaje de chat

```json
{
  "type": "twitch",
  "platform": "twitch",
  "chatname": "usuario",
  "chatmessage": "Hola!",
  "nameColor": "#9146FF",
  "chatimg": "https://...",
  "roles": [{ "type": "moderator", "label": "Mod" }],
  "mid": "tw-abc123"
}
```

### Formato de donación/sub/bits

```json
{
  "type": "donation",
  "platform": "twitch",
  "donationType": "bits",
  "chatname": "usuario",
  "chatmessage": "Hola!",
  "amount": 100,
  "currency": "BITS",
  "nameColor": "#9146FF",
  "chatimg": "https://...",
  "mid": "tw-bits-123"
}
```

**donationType** puede ser: `bits`, `sub`, `resub`, `subgift`, `mysterygift` (Twitch) · `gift`, `subscribe` (TikTok) · `superchat`, `supersticker`, `member` (YouTube) · `giftedsub`, `sub` (Kick)

---

## Dependencias

```json
{
  "express": "^4.18.2",
  "tmi.js": "^1.8.5",
  "tiktok-live-connector": "^1.1.9",
  "ws": "^8.14.2"
}
```

YouTube usa el módulo nativo `https` de Node, no requiere dependencia extra.

---

*Última actualización: febrero 2026*
