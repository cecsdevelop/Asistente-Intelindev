# Asistente Intelindev

Asistente de voz con IA para atención telefónica y web de Intelindev. Responde llamadas, explica los servicios de la empresa, revisa disponibilidad en Google Calendar y agenda citas automáticamente, con confirmación por correo tanto para el cliente como para el dueño del calendario.

## Cómo funciona

```
Llamada (teléfono o navegador)
        │
        ▼
   Retell AI  ──(WebSocket, protocolo Custom LLM)──►  server.js
        │                                                │
        │                                                ├─► Claude (Anthropic) — conversación y decisión de herramientas
        │                                                ├─► Google Calendar API — disponibilidad y creación de eventos
        │                                                └─► Nodemailer (Gmail) — correos de confirmación
        ▼
   Voz del agente
```

Retell AI se encarga de la telefonía y de convertir voz a texto y texto a voz. Este servidor actúa como el "cerebro" (Custom LLM): recibe la transcripción de cada turno, decide qué responder usando Claude, y cuando hace falta, usa dos herramientas:

- `revisar_disponibilidad`: consulta los eventos del día en Google Calendar.
- `agendar_cita`: crea el evento, validando que no exista un conflicto real y que haya al menos un dato de contacto (correo o teléfono).
- `finalizar_llamada`: cierra la llamada de forma controlada cuando el cliente confirma que no necesita nada más.

## Requisitos

- Node.js 18 o superior (usa `fetch` nativo).
- Una cuenta de [Retell AI](https://www.retellai.com/) con un agente configurado en modo **Custom LLM**.
- Una API key de [Anthropic](https://console.anthropic.com/).
- Una cuenta de servicio de Google Cloud con acceso a Google Calendar API.
- Una cuenta de Gmail con una [contraseña de aplicación](https://myaccount.google.com/apppasswords) para el envío de correos.

## Instalación

```bash
npm install
cp .env.example .env
```

Completa `.env` con tus credenciales:

| Variable | Descripción |
|---|---|
| `RETELL_API_KEY` | API key de tu cuenta de Retell AI |
| `ANTHROPIC_API_KEY` | API key de Anthropic (Claude) |
| `PORT` | Puerto local del servidor (por defecto `8080`) |
| `AGENT_ID` | ID del agente de Retell, usado por el endpoint `/create-web-call` |
| `GMAIL_USER` | Cuenta de Gmail que envía y recibe las notificaciones |
| `GMAIL_APP_PASSWORD` | Contraseña de aplicación de esa cuenta de Gmail |

Además necesitas un archivo `credenciales.json` en la raíz del proyecto con las credenciales de la cuenta de servicio de Google (descargado desde Google Cloud Console). Ese archivo **no se sube al repositorio** (ver `.gitignore`).

También edita `CALENDAR_ID` en [server.js](server.js) con el correo del calendario que quieres usar, y comparte ese calendario con el correo de la cuenta de servicio (permiso "Hacer cambios en los eventos").

El horario laboral (`ZONA_NEGOCIO`, `HORA_APERTURA`, `HORA_CIERRE` en `server.js`) está configurado para Orlando, Florida (`America/New_York`, lunes a viernes de 9:00 a.m. a 6:00 p.m.). El asistente pregunta desde qué país o ciudad llama el cliente para explicarle la equivalencia horaria, y el servidor rechaza agendar citas fuera de ese horario aunque el modelo se equivoque.

## Uso

```bash
node server.js
```

Para exponer el servidor local a Retell durante pruebas, usa un túnel (por ejemplo [ngrok](https://ngrok.com/)):

```bash
ngrok http 8080
```

En la configuración del agente en Retell AI, en **Custom LLM URL**, coloca la URL del túnel en formato WebSocket seguro apuntando a `/llm-websocket`, por ejemplo:

```
wss://tu-subdominio.ngrok-free.dev/llm-websocket
```

### Widget de llamada web

[index.html](index.html) es un botón standalone que permite iniciar una llamada de voz directo desde el navegador (usa el SDK `retell-client-js-sdk` y el endpoint `POST /create-web-call` del servidor para generar el token de la llamada). Ábrelo directamente en el navegador mientras el servidor corre en local.

## Notas de seguridad

- `.env` y `credenciales.json` están excluidos del control de versiones porque contienen secretos reales. Usa `.env.example` como plantilla.
- El servidor valida en el propio código (no solo confía en el modelo) que exista al menos un dato de contacto antes de agendar, y que el horario solicitado no choque con una cita ya existente de otra persona.
