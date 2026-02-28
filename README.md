# 🎮 Meeve Multichat v2

Chat unificado para **Twitch + Kick + TikTok + YouTube** con overlay para OBS.  
100% autónomo — sin Social Stream Ninja, sin dependencias externas.

---

## 📁 Estructura del repositorio

```
multichat/
├── server/
│   ├── index.js        ← Servidor Node.js (Railway / Render)
│   ├── package.json
│   └── railway.toml
├── dashboard/
│   └── index.html      ← Panel de control (abrís en tu navegador)
└── overlay/
    ├── index.html      ← Chat multichat para OBS (burbujas múltiples)
    ├── chat_uno.html   ← Chat de UN solo mensaje para OBS
    └── destacador.html ← Mensaje destacado al clickear en el dashboard
```

---

## 🚀 Cómo funciona el sistema completo

```
Twitch ──────────────────────────────────────────┐
TikTok ──────────────────────────────────────────┤
YouTube (polling API) ───────────────────────────┤──► Servidor Node.js (Railway)
Kick ──► Dashboard (tu navegador) ───────────────┘         │ WebSocket
                                                            │
                               ┌────────────────────────────┤
                               │                            │
                        overlay/index.html        overlay/destacador.html
                        overlay/chat_uno.html
                               │                            │
                            OBS (fuentes de navegador)
```

### Overlays disponibles

| Archivo | Uso |
|---|---|
| `overlay/index.html` | Chat estilo burbuja con múltiples mensajes. Conéctalo normalmente como fuente en OBS. |
| `overlay/chat_uno.html` | Muestra UN solo mensaje a la vez (el más reciente). Reemplaza al anterior automáticamente. |
| `overlay/destacador.html` | **Solo muestra mensajes destacados desde el dashboard**. Aparece al clickear y desaparece solo. |

---

## 🖱️ Destacar mensajes (nueva función)

1. Abre el **dashboard** en tu navegador mientras streameas
2. Cada mensaje tiene un botón **📌 Destacar** que aparece al pasar el mouse
3. Al clickearlo (o clickear el mensaje directamente), el mensaje se envía a todos los overlays con tipo `highlight`
4. El **`destacador.html`** lo muestra durante **12 segundos** y luego desaparece solo
5. Desde la barra inferior del dashboard podés ver qué mensaje está destacado y quitarlo con **✕ Quitar destacado**

El tiempo de visibilidad se puede cambiar con el parámetro `?showtime=8000` (en ms) en la URL del overlay.

---

## ⚙️ Setup en Railway / Render

### Variables de entorno

| Variable | Descripción |
|---|---|
| `TWITCH_CHANNEL` | Tu nombre en Twitch (sin #) |
| `KICK_CHANNEL` | Tu nombre en Kick |
| `TIKTOK_USERNAME` | Tu usuario de TikTok (sin @) |
| `YOUTUBE_HANDLE` | Tu handle de YouTube (ej: `@Meevepics`) |
| `YOUTUBE_API_KEY` | API Key de Google Cloud → YouTube Data API v3 |
| `TIKTOK_SESSION_ID` | (Opcional) Si TikTok da error 403 |

### Configuración Railway

- **Root Directory:** `server`
- **Start Command:** `node index.js`
- **Health check:** `/health`

---

## 🎬 Agregar overlays a OBS

Para cada overlay, crea una **Fuente de Navegador** en OBS:

```
overlay/index.html:
https://tuusuario.github.io/multichat/overlay/index.html?server=wss://tu-app.up.railway.app

overlay/chat_uno.html:
https://tuusuario.github.io/multichat/overlay/chat_uno.html?server=wss://tu-app.up.railway.app

overlay/destacador.html:
https://tuusuario.github.io/multichat/overlay/destacador.html?server=wss://tu-app.up.railway.app

# Parámetros opcionales para el destacador:
?showtime=12000   → tiempo en ms (default: 12000 = 12 segundos)
```

---

## 🔗 Endpoints del servidor

| Endpoint | Método | Descripción |
|---|---|---|
| `/health` | GET | Estado del servidor (UptimeRobot) |
| `/api/status` | GET | Estado detallado en JSON |
| `/api/tiktok/restart` | POST | Fuerza reconexión de TikTok |
| `/api/youtube/restart` | POST | Fuerza reconexión de YouTube |
| `/api/kick/channel-id` | GET/POST | Gestión del chatroom ID de Kick |

---

## 📨 Mensajes WebSocket — Formato

### Chat normal
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

### Mensaje destacado (generado desde el dashboard)
```json
{
  "type": "highlight",
  "platform": "twitch",
  "chatname": "usuario",
  "chatmessage": "Hola!",
  "chatimg": "https://...",
  "nameColor": "#9146FF",
  "roles": [],
  "mid": "hl-1234567890"
}
```

### Limpiar destacado
```json
{ "type": "highlight_clear" }
```

---

*Última actualización: febrero 2026*
