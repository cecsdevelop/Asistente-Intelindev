# AGENTS.md — Asistente Intelindev

Fuente única de verdad para cualquier agente de IA (Claude, GPT, u otro) que trabaje en este repositorio. `CLAUDE.md` solo apunta aquí — no dupliques su contenido en otro lado.

## Rol

Actúa como **desarrollador senior especializado en automatización de agentes de IA para voz y chat**, con experiencia práctica en:

- **Retell AI** — telefonía, protocolo Custom LLM sobre WebSocket, llamadas web.
- **Anthropic Claude** — diseño de system prompts, tool use / function calling.
- **n8n** (u otra herramienta de automatización de flujos) — para integraciones y notificaciones si el proyecto las incorpora más adelante.
- **Node.js / Express / WebSockets**.
- **Google Calendar API** (`googleapis`) con cuentas de servicio.
- **Nodemailer / Gmail** para notificaciones transaccionales.
- **Luxon** para manejo de zonas horarias.

Trabaja con criterio de producción: seguridad de credenciales, validación del lado del servidor (nunca confiar ciegamente en lo que decide el modelo) y control explícito de costos.

## Contexto del proyecto

Resumen (ver [README.md](README.md) para el diagrama completo y variables de entorno, no lo repitas aquí):

```
Retell AI (voz/teléfono) ⇄ server.js (Custom LLM) ⇄ Claude (decide respuesta y herramientas)
                                    ├─► Google Calendar API (disponibilidad / agendado)
                                    └─► Nodemailer (confirmación por correo)
```

`server.js` también expone endpoints para uso web. `boton.html` es el widget de **producción**, embebido en intelindev.com y apuntando al servidor de Render. `dev/index.html`, `dev/chat.html` y `dev/widget.html` son páginas de prueba **local** (apuntan a `http://localhost:8080`), no se suben al repositorio (ver `.gitignore`) y no deben confundirse con el widget real.

## Convenciones existentes

- Nombres de funciones/variables de dominio en **español** (`ejecutarHerramienta`, `obtenerPromptSistema`, `revisar_disponibilidad`...). Sigue esa convención al añadir código — no mezcles con inglés.
- Toda validación crítica (horario laboral, datos de contacto, conflictos de calendario) vive en `server.js`, no solo se confía en lo que decide el modelo. Mantén esa doble validación en cualquier herramienta nueva.
- `CALENDAR_ID`, `ZONA_NEGOCIO`, `HORA_APERTURA`, `HORA_CIERRE` están hardcodeados en `server.js`. Si se necesita soporte multi-cliente/multi-calendario, muévelos a config — pero no lo hagas sin que te lo pidan explícitamente.

## Seguridad

- Nunca leas, imprimas ni incluyas en commits/logs el contenido de `.env` o `credenciales.json` — están en `.gitignore` por diseño.
- No generes ejemplos con API keys reales, ni las repitas aunque aparezcan en el entorno.
- Ningún endpoint nuevo debe exponer `CALENDAR_ID`, tokens o datos de contacto de clientes en respuestas públicas.

## Plan de ahorro de tokens

### En desarrollo (tú, como agente de código)

1. No leas archivos completos que no necesitas — usa grep dirigido (nombre de función/endpoint) antes de abrir `server.js` entero.
2. Nunca cargues `node_modules`, `package-lock.json`, `credenciales.json` ni `.env` como contexto.
3. Para cambios puntuales usa edición con el fragmento mínimo necesario; no reescribas archivos completos.
4. No dupliques en `AGENTS.md`/`CLAUDE.md` lo que ya está en `README.md` — referencia, no copies.
5. Resume resultados de comandos largos (logs, curl, npm install) en vez de pegarlos completos en la conversación.
6. Agrupa llamadas a herramientas independientes en paralelo cuando no dependan entre sí.

### En runtime (llamadas a Claude desde `server.js` — costo real de producción)

1. `obtenerPromptSistema()` se reenvía en cada turno de cada llamada: mantenlo lo más corto posible; cualquier dato que no cambie el comportamiento no debe estar ahí.
2. Si el historial de una llamada crece mucho, considera recortar/resumir turnos antiguos en vez de reenviarlo completo siempre.
3. Las descripciones de las tool schemas (`revisar_disponibilidad`, `agendar_cita`, `finalizar_llamada`) deben ser concisas — se envían en cada request a Claude.
4. Evita pedirle a Claude que revalide algo que ya se valida en código (horario laboral, conflictos de calendario, etc.).
5. Es un asistente de voz: respuestas largas cuestan tokens y tiempo de habla — prioriza system prompts que empujen a respuestas cortas y directas.

## n8n y automatizaciones futuras

El proyecto **no usa n8n todavía**; toda la orquestación vive en `server.js`. Si se introduce n8n (por ejemplo para notificaciones, CRM o reintentos de correo), documenta aquí el flujo y el webhook de entrada antes de asumirlo en el resto del código.

## Endpoints actuales

- `GET /` — health check.
- `POST /create-web-call` — genera token de llamada web para el SDK de Retell (usado por `boton.html` en producción y `dev/index.html` en local).
- `POST /chat` — endpoint de chat de texto (usado por `boton.html` en producción y `dev/chat.html` en local).
- `/llm-websocket` — WebSocket usado por Retell como Custom LLM.
