require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const { Resend } = require('resend');
const cors = require('cors');
const { DateTime } = require('luxon');

const app = express();
const port = process.env.PORT || 8080;

// 1. CONFIGURACIÓN DEL CALENDARIO
const CALENDAR_ID = 'cecsdevelop@gmail.com';

// Zona horaria real del negocio (Orlando, Florida). Se usa un nombre de zona IANA
// en vez de un offset fijo (-05:00/-04:00) para que el horario de verano (DST)
// se calcule solo, en vez de arrastrar un desfase manual todo el año.
const ZONA_NEGOCIO = 'America/New_York';
const HORA_APERTURA = 9;  // 9:00 a.m., hora del Este
const HORA_CIERRE = 18;   // 6:00 p.m., hora del Este (última cita posible empieza a las 17:00)

function fechaEnZonaNegocio(fecha, hora) {
  return DateTime.fromISO(`${fecha}T${hora}`, { zone: ZONA_NEGOCIO });
}

function estaEnHorarioLaboral(dt) {
  return dt.isValid && dt.weekday >= 1 && dt.weekday <= 5 && dt.hour >= HORA_APERTURA && dt.hour < HORA_CIERRE;
}

const auth = new google.auth.GoogleAuth({
  keyFile: './credenciales.json',
  scopes: ['https://www.googleapis.com/auth/calendar']
});

const calendar = google.calendar({ version: 'v3', auth: auth });

auth.getClient().then(() => {
  console.log("✅ ¡Conexión a Google Calendar exitosa y autorizada!");
}).catch(err => {
  console.error("❌ Error autenticando con Google:", err.message);
});

// Notificación por correo al dueño del calendario (la API de Calendar no la envía
// por defecto y, al usar una cuenta de servicio sobre un Gmail personal, tampoco
// se puede invitar attendees para que Google mande la invitación automáticamente).
// Se manda por la API HTTPS de Resend en vez de SMTP: varios hosts (Render incluido)
// bloquean o cortan las conexiones salientes por los puertos SMTP, lo que hacía que
// estos correos fallaran siempre con "Connection timeout" sin que nadie lo notara.
const resend = new Resend(process.env.RESEND_API_KEY);
// Antes de verificar un dominio propio en Resend, solo se puede enviar desde este
// remitente de pruebas — funciona, pero para producción real conviene verificar un
// dominio (ej. intelindev.com) y apuntar RESEND_FROM_EMAIL a algo como alex@intelindev.com.
const REMITENTE = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

async function notificarNuevaCita({ nombre, fecha, hora, telefono, correo }) {
  const contacto = [telefono ? `Teléfono: ${telefono}` : null, correo ? `Correo: ${correo}` : null]
    .filter(Boolean).join(' | ');

  try {
    const { error } = await resend.emails.send({
      from: `Alex (Asistente Intelindev) <${REMITENTE}>`,
      to: process.env.OWNER_EMAIL,
      subject: `Nueva cita agendada: ${nombre} - ${fecha} ${hora}`,
      text: `Se agendó una nueva cita por teléfono.\n\nCliente: ${nombre}\nFecha: ${fecha}\nHora: ${hora}\n${contacto}`
    });
    if (error) throw new Error(error.message);
    console.log("✉️ Correo de notificación enviado al dueño del calendario.");
  } catch (e) {
    console.error("❌ Error enviando correo de notificación al dueño:", e.message);
  }

  // Confirmación al cliente, solo si dejó correo (si solo dejó teléfono no hay a dónde enviarle).
  if (correo) {
    try {
      const { error } = await resend.emails.send({
        from: `Intelindev <${REMITENTE}>`,
        to: correo,
        subject: `Confirmación de tu cita con Intelindev - ${fecha} ${hora}`,
        text: `Hola ${nombre},\n\nTu cita con Intelindev quedó confirmada.\n\nFecha: ${fecha}\nHora: ${hora}\n\nSi necesitas reagendar o cancelar, contáctanos respondiendo a este correo o al +1 407 555 0199.\n\nSaludos,\nEquipo Intelindev`
      });
      if (error) throw new Error(error.message);
      console.log(`✉️ Correo de confirmación enviado al cliente (${correo}).`);
    } catch (e) {
      console.error("❌ Error enviando confirmación al cliente:", e.message);
    }
  }
}

// 2. CONFIGURACIÓN DE CLAUDE Y HERRAMIENTAS
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Función (no constante) porque "hoy" tiene que recalcularse en cada llamada;
// un string fijo se habría quedado desactualizado desde el día siguiente.
function obtenerPromptSistema() {
  const hoy = DateTime.now().setZone(ZONA_NEGOCIO).setLocale('es').toFormat("d 'de' MMMM 'de' yyyy");

  return `Eres Alex, el asistente virtual telefónico de Intelindev, una agencia de Desarrollo de Software y SEO.
Tu trabajo es atender a los clientes con un tono profesional, tecnológico, muy amable y CONVERSACIONAL. Sé breve en tus respuestas.

REGLAS DE FORMATO Y VOZ (¡MUY IMPORTANTE!):
- NO uses formato Markdown. NO uses asteriscos, guiones, listas con viñetas, ni texto en negritas.
- Escribe todo en párrafos normales, en texto plano. Usa comas y puntos para darle un ritmo natural a tu voz y evitar sonar robótico.

IDIOMA:
- Eres bilingüe. Responde siempre en el idioma que use el cliente en su mensaje más reciente: si te escribe o habla en inglés, continúa toda la conversación en inglés con el mismo tono profesional y cálido; si es en español, sigue en español.
- Si el cliente cambia de idioma a mitad de la conversación, cambia con él a partir de ese momento.

INICIO DE LA LLAMADA Y TRATO AL CLIENTE:
- Al iniciar la llamada, el sistema ya saludó al cliente diciendo "Hola, soy Alex, tu asistente de inteligencia artificial para Intelindev. ¿En qué puedo ayudarte hoy?". Tú no repitas ese saludo, solo continúa la conversación a partir de lo que el cliente responda.
- No preguntes el nombre del cliente de entrada. Escucha primero qué necesita, y pídele su nombre de forma natural más adelante en la conversación (por ejemplo, al ofrecer agendar una cita, o si quieres dirigirte a él con más cercanía).
- En cuanto sepas su nombre, úsalo de forma natural durante el resto de la conversación para generar empatía.

INFORMACIÓN DE LA EMPRESA:
- Servicios principales: Desarrollo de Software a la medida, SEO, Outsourcing, Desarrollo de Sitios Web y E-commerce, y Diseño Digital.
- Ubicación: Orlando, Florida, Estados Unidos (hora del Este, America/New_York).
- Contacto: Correo a info@intelindev.com o al teléfono +1 407 555 0199.
- Precios: No damos precios exactos por teléfono porque cada proyecto es a la medida.

TU OBJETIVO:
Explica nuestros servicios brevemente y ofrece agendar una cita o videollamada con nuestro equipo de Project Management.

REGLAS DE AGENDAMIENTO:
- Hoy es ${hoy}, hora del Este (America/New_York).
- Nuestro horario laboral es de lunes a viernes, de 9:00 a.m. a 6:00 p.m., hora del Este. Nunca ofrezcas ni confirmes una cita fuera de ese rango.
- SIEMPRE usa la herramienta 'revisar_disponibilidad' primero cuando el cliente acepte agendar una reunión.
- Ya que tienes el nombre del cliente desde el principio, confirma la hora deseada y la fecha.
- Antes de llamar a 'agendar_cita' pide primero el correo electrónico del cliente para poder confirmarle la cita. Si el cliente no tiene correo a la mano o prefiere no darlo, pide en su lugar el número de teléfono de contacto y léelo en voz alta dígito por dígito para verificar que lo capturaste bien.
- Necesitas obligatoriamente al menos uno de los dos datos (correo o teléfono) antes de agendar. Si el cliente se niega a dar ambos, explica que necesitas al menos uno para poder confirmarle la cita y contactarlo en caso de imprevistos.
- Nunca llames a 'agendar_cita' sin tener al menos el correo o el teléfono del cliente.

ZONA HORARIA DEL CLIENTE:
- Nosotros operamos en hora del Este de Estados Unidos (Orlando, Florida). Los horarios que te da 'revisar_disponibilidad' y los que agenda 'agendar_cita' están siempre en esa zona horaria.
- Cuando el cliente quiera agendar una reunión y no sepas desde qué país o ciudad llama, pregúntaselo de forma natural, por ejemplo: "¿desde qué país o ciudad nos contactas?".
- Con esa información, calcula la diferencia horaria con nuestra hora del Este y explícasela con claridad antes de confirmar cualquier cita. Por ejemplo: "tus 5 de la tarde serían nuestras 9 de la noche, y lamentablemente no estamos disponibles a esa hora; sin embargo, tenemos disponible nuestras 6 de la tarde, que serían tus 2 de la tarde, ¿te funcionaría?".
- Si el horario que menciona el cliente, convertido a nuestra hora, cae fuera de nuestro horario laboral (9:00 a.m.–6:00 p.m., lunes a viernes, hora del Este), explícaselo con la conversión y ofrécele una alternativa dentro de nuestro horario, también convertida a su hora local.
- Si el cliente no quiere decir desde dónde llama, continúa asumiendo que la hora que menciona ya está en hora del Este.

CIERRE DE LLAMADA:
- Cuando el cliente confirme que no necesita nada más, despídete de forma breve y cálida usando su nombre, y en ese mismo mensaje llama a la herramienta 'finalizar_llamada'.
- No vuelvas a ofrecer ayuda, ni repitas preguntas, ni uses 'revisar_disponibilidad' u otra herramienta después de que el cliente ya haya confirmado que no necesita nada más.`;
}

// Detección determinística de frases de cierre. No confiamos solo en que el modelo
// elija bien la herramienta 'finalizar_llamada': si el último mensaje del cliente
// suena claramente a "no necesito nada más", cortamos el flujo de herramientas
// de calendario por completo en ese turno.
function pareceCierre(texto) {
  if (!texto || typeof texto !== 'string') return false;
  const t = texto.toLowerCase().trim();
  if (t.includes('?')) return false;
  return /(nada m[aá]s|eso es todo|eso ser[ií]a todo|no necesito nada|ya no necesito|no,? gracias|as[ií] est[aá] bien|solo (eso|era eso)|nada,? gracias)/.test(t);
}

const tools = [
  {
    name: "revisar_disponibilidad",
    description: "Revisa los eventos programados en el calendario para un día específico.",
    input_schema: {
      type: "object",
      properties: { fecha: { type: "string", description: "Fecha a consultar en formato YYYY-MM-DD" } },
      required: ["fecha"]
    }
  },
  {
    name: "agendar_cita",
    description: "Crea un nuevo evento en el calendario.",
    input_schema: {
      type: "object",
      properties: {
        fecha: { type: "string", description: "Fecha de la cita en formato YYYY-MM-DD" },
        hora: { type: "string", description: "Hora de inicio en formato HH:MM (24 horas)" },
        nombre: { type: "string", description: "Nombre del cliente" },
        correo: { type: "string", description: "Correo electrónico del cliente. Pregúntalo primero; si el cliente no lo tiene a la mano, pide el teléfono en su lugar." },
        telefono: { type: "string", description: "Número de teléfono de contacto del cliente. Solo pregúntalo si el cliente no puede dar su correo." }
      },
      required: ["fecha", "hora", "nombre"]
    }
  },
  {
    name: "finalizar_llamada",
    description: "Úsala SOLO cuando el cliente confirme explícitamente que no necesita nada más (ej. 'no, nada más', 'eso es todo, gracias'). Antes de llamarla, incluye en el mismo mensaje una despedida breve y amable usando el nombre del cliente.",
    input_schema: { type: "object", properties: {}, required: [] }
  }
];

// 3. LÓGICA DE LA CONVERSACIÓN (compartida entre voz y chat de texto)

async function generarDespedida(mensajes) {
  const msgDespedida = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 100,
    system: obtenerPromptSistema() + "\n\nNOTA: El cliente acaba de confirmar que no necesita nada más. No tienes herramientas disponibles en este mensaje. Responde ÚNICAMENTE con una despedida breve, cálida y profesional usando su nombre si lo sabes, en lenguaje natural. No ofrezcas más ayuda, no hagas preguntas, y no menciones nombres de herramientas ni código (por ejemplo, nunca escribas la palabra 'finalizar_llamada').",
    messages: mensajes
  });
  const bloqueTexto = msgDespedida.content.find(c => c.type === 'text');
  return (bloqueTexto && bloqueTexto.text.trim()) || "Ha sido un placer atenderte. Que tengas un excelente día, ¡hasta luego!";
}

async function ejecutarHerramienta(toolCall) {
  if (toolCall.name === 'revisar_disponibilidad') {
    try {
      const inicioDia = DateTime.fromISO(`${toolCall.input.fecha}T00:00:00`, { zone: ZONA_NEGOCIO });
      if (!inicioDia.isValid) {
        return "La fecha indicada no es válida.";
      }
      const finDia = inicioDia.endOf('day');
      const response = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: inicioDia.toISO(),
        timeMax: finDia.toISO(),
        singleEvents: true,
        orderBy: 'startTime',
      });
      const eventos = response.data.items;
      const avisoHorario = "Nuestro horario laboral es de lunes a viernes, de 9:00 a.m. a 6:00 p.m., hora del Este (America/New_York).";
      if (eventos.length === 0) {
        return `Todo el día está libre. ${avisoHorario}`;
      }
      const formatoHora = { hour: '2-digit', minute: '2-digit', timeZone: ZONA_NEGOCIO };
      const ocupados = eventos.map(e => {
        const inicio = new Date(e.start.dateTime || e.start.date).toLocaleTimeString('es-MX', formatoHora);
        const fin = new Date(e.end.dateTime || e.end.date).toLocaleTimeString('es-MX', formatoHora);
        return `de ${inicio} a ${fin}`;
      }).join(', y ');
      return `Horarios ocupados: ${ocupados}. Cualquier otro horario dentro del horario laboral está libre. Antes de confirmar con el cliente, verifica que la hora que pide no caiga dentro de ninguno de esos rangos ocupados (inicio inclusive, fin exclusive). ${avisoHorario}`;
    } catch (e) {
      console.error("❌ Error leyendo calendario:", e.message);
      return "Hubo un error al leer el calendario. Pide disculpas al usuario.";
    }
  }

  if (toolCall.name === 'agendar_cita') {
    // Validación de servidor: nunca confiar solo en el 'required' del schema
    const { fecha, hora, nombre, telefono, correo } = toolCall.input;
    const telefonoValido = telefono && telefono.trim().length >= 7;
    const correoValido = correo && correo.includes('@');
    if (!telefonoValido && !correoValido) {
      return "Falta un dato de contacto válido (correo o teléfono). Pide al usuario al menos uno de los dos antes de agendar.";
    }

    const inicioSolicitado = fechaEnZonaNegocio(fecha, hora);
    if (!inicioSolicitado.isValid) {
      return "La fecha u hora indicada no es válida.";
    }
    if (!estaEnHorarioLaboral(inicioSolicitado)) {
      return "Ese horario está fuera de nuestro horario laboral (lunes a viernes, de 9:00 a.m. a 6:00 p.m., hora del Este). No lo agendes. Si sabes desde qué país o ciudad llama el cliente, explícale la equivalencia horaria y ofrécele una alternativa dentro de nuestro horario, convertida a su hora local. Si no lo sabes, pregúntale desde dónde llama para poder ayudarle a encontrar un horario que le funcione.";
    }

    try {
      const start = inicioSolicitado.toJSDate();
      const end = inicioSolicitado.plus({ hours: 1 }).toJSDate();

      const checkConflicto = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
      });

      const esNuestraPropiaCita = checkConflicto.data.items.length > 0 &&
        checkConflicto.data.items.every(e => {
          const desc = e.description || '';
          return (telefonoValido && desc.includes(`Teléfono: ${telefono}`)) ||
                 (correoValido && desc.includes(`Correo: ${correo}`));
        });

      if (checkConflicto.data.items.length > 0 && !esNuestraPropiaCita) {
        console.log("⚠️ Conflicto real: el horario ya está ocupado por otra cita.");
        return "Ese horario ya no está disponible, alguien más lo ocupó. Dile al usuario que ese horario ya no está libre y pídele otra hora, luego usa revisar_disponibilidad de nuevo antes de reintentar.";
      }
      if (esNuestraPropiaCita) {
        console.log("ℹ️ Cita duplicada del mismo cliente evitada, ya existía.");
        return "Esa cita ya estaba agendada previamente con estos mismos datos. Dile al usuario que su cita está confirmada.";
      }

      const descripcionPartes = [];
      if (correoValido) descripcionPartes.push(`Correo: ${correo}`);
      if (telefonoValido) descripcionPartes.push(`Teléfono: ${telefono}`);

      await calendar.events.insert({
        calendarId: CALENDAR_ID,
        resource: {
          summary: `Cita: ${nombre}`,
          description: descripcionPartes.join('\n'),
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() }
        }
      });
      console.log("✅ Cita guardada en Google Calendar.");
      // No se espera (await) para no meter latencia extra a la respuesta.
      notificarNuevaCita({ nombre, fecha, hora, telefono: telefonoValido ? telefono : null, correo: correoValido ? correo : null });
      return "Cita agendada exitosamente.";
    } catch (e) {
      console.error("❌ Error agendando:", e.message);
      return "No se pudo agendar la cita. Pide disculpas al usuario.";
    }
  }

  return "";
}

// Corre el ciclo de Claude + herramientas hasta obtener una respuesta final en texto.
// onHerramienta(nombre) es opcional y se usa solo en voz, para enviar la frase de espera.
async function ejecutarConversacion(mensajesActuales, onHerramienta) {
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: obtenerPromptSistema(),
    messages: mensajesActuales,
    tools: tools
  });

  if (msg.stop_reason === 'tool_use') {
    const toolCall = msg.content.find(c => c.type === 'tool_use');
    console.log(`🛠️ Claude usando herramienta: ${toolCall.name} con datos:`, toolCall.input);

    if (toolCall.name === 'finalizar_llamada') {
      const bloqueTexto = msg.content.find(c => c.type === 'text');
      const despedida = (bloqueTexto && bloqueTexto.text.trim()) || "Ha sido un placer atenderte. Que tengas un excelente día, ¡hasta luego!";
      return { texto: despedida, cerrar: true };
    }

    if (onHerramienta) onHerramienta(toolCall.name);

    const resultadoHerramienta = await ejecutarHerramienta(toolCall);

    mensajesActuales.push({ role: "assistant", content: msg.content });
    mensajesActuales.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolCall.id, content: resultadoHerramienta }]
    });

    return ejecutarConversacion(mensajesActuales, onHerramienta);
  }

  return { texto: msg.content[0].text, cerrar: false };
}

app.use(cors()); // Permite conexiones desde páginas web
app.use(express.json()); // Permite leer datos en JSON

app.get('/', (req, res) => res.send('Servidor funcionando con Google Calendar y Web Webhooks!'));

// Genera el token para la llamada web (usado por el widget del navegador)
app.post('/create-web-call', async (req, res) => {
  try {
    const response = await fetch('https://api.retellai.com/v2/create-web-call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RETELL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agent_id: process.env.AGENT_ID
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error creando web call:", error);
    res.status(500).json({ error: 'Failed to create web call' });
  }
});

// Chat de texto (accesibilidad): mismo cerebro que la llamada de voz, sin telefonía.
// El cliente manda el historial completo { messages: [{role, content}, ...] } y recibe
// la respuesta en texto. content son strings simples, igual que el transcript de Retell.
app.post('/chat', async (req, res) => {
  try {
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const ultimoTurno = messages[messages.length - 1];

    if (!ultimoTurno || ultimoTurno.role !== 'user' || !ultimoTurno.content) {
      return res.status(400).json({ error: 'Se requiere al menos un mensaje del usuario.' });
    }

    console.log(`💬 Chat - último mensaje: "${ultimoTurno.content}" | ¿cierre detectado?: ${pareceCierre(ultimoTurno.content)}`);

    if (pareceCierre(ultimoTurno.content)) {
      const despedida = await generarDespedida(messages);
      return res.json({ respuesta: despedida, cerrar: true });
    }

    const { texto, cerrar } = await ejecutarConversacion([...messages]);
    res.json({ respuesta: texto, cerrar });
  } catch (e) {
    console.error("❌ Error en /chat:", e.message);
    res.status(500).json({ error: 'No se pudo procesar el mensaje.' });
  }
});

const server = app.listen(port, () => console.log(`Servidor iniciado en el puerto ${port}`));
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  if (request.url.startsWith('/llm-websocket')) {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});

const SALUDO_INICIAL = "Hola, soy Alex, tu asistente de inteligencia artificial para Intelindev. ¿En qué puedo ayudarte hoy?";

wss.on('connection', (ws, req) => {
  console.log(`🟢 Retell AI conectado.`);

  // Begin message: el agente debe hablar primero. Retell trata response_id: 0
  // como el primer mensaje del agente, no como respuesta a un turno del usuario.
  ws.send(JSON.stringify({
    response_type: 'response',
    response_id: 0,
    content: SALUDO_INICIAL,
    content_complete: true,
    end_call: false
  }));

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.interaction_type === 'response_required') {
        const responseId = data.response_id;
        let messages = data.transcript.map(turn => ({
           role: turn.role === 'agent' ? 'assistant' : 'user',
           content: turn.content
        })).filter(turn => turn.content !== '');

        // Atajo determinístico: si el cliente acaba de decir algo como "no, nada más",
        // no le damos ninguna herramienta a Claude en este turno. Así se elimina por completo
        // la posibilidad de que el modelo vuelva a llamar revisar_disponibilidad u otra
        // herramienta en vez de simplemente despedirse.
        const ultimoTurno = messages[messages.length - 1];
        if (ultimoTurno && ultimoTurno.role === 'user') {
          console.log(`👤 Último mensaje del cliente: "${ultimoTurno.content}" | ¿cierre detectado?: ${pareceCierre(ultimoTurno.content)}`);
        }
        if (ultimoTurno && ultimoTurno.role === 'user' && pareceCierre(ultimoTurno.content)) {
          console.log('👋 Frase de cierre detectada, forzando despedida sin herramientas.');
          const despedida = await generarDespedida(messages);
          ws.send(JSON.stringify({
            response_type: 'response',
            response_id: responseId,
            content: despedida,
            content_complete: true,
            end_call: true
          }));
          return;
        }

        // --- FRASE DE ESPERA ---
        // Solo se envía una vez por turno, aunque Claude encadene varias herramientas
        // (ej. revisar disponibilidad y luego agendar), para no repetir "espere un momento".
        let avisoEsperaEnviado = false;
        const { texto, cerrar } = await ejecutarConversacion(messages, (nombreHerramienta) => {
          if (avisoEsperaEnviado) return;
          let fraseEspera = "Claro, por favor permítame un momento mientras reviso la disponibilidad en el calendario.";
          if (nombreHerramienta === 'agendar_cita') {
            fraseEspera = "Excelente, deme un segundo mientras confirmo y guardo su cita en el sistema.";
          }
          ws.send(JSON.stringify({
            response_type: 'response',
            response_id: responseId,
            content: fraseEspera,
            content_complete: false, // Le dice a Retell que aún falta la respuesta real
            end_call: false
          }));
          avisoEsperaEnviado = true;
        });

        ws.send(JSON.stringify({
          response_type: 'response',
          response_id: responseId,
          content: texto,
          content_complete: true,
          end_call: cerrar
        }));
      }
    } catch (e) {
      console.error('Error general:', e);
    }
  });

  ws.on('close', () => console.log('🔴 Conexión cerrada con Retell.'));
});