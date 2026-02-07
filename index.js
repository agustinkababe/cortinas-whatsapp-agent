// index.js — FINAL (v2: name+zone before handoff, no photos)
// - dotenv (.env) for config
// - AI extraction for name/zone
// - Lead-gen prompt (NO pide fotos)
// - Handoff ONLY when: budgetIntent OR visitIntent OR humanIntent
// - Before handoff: MUST have name + zone (asks missing, then auto-handoff)
// - DEV_MODE=true: suppress Twilio outbound; still saves snapshots/logs
// - After handoff: forwards new lead messages only if DEV_MODE=false

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const twilio = require("twilio");
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886";
const HANDOFF_TO = process.env.HANDOFF_TO; // e.g. whatsapp:+5493416601666

const DEV_MODE = String(process.env.DEV_MODE || "true").toLowerCase() === "true";

const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ======= Folders =======
const CONV_DIR = path.join(__dirname, "conversations");
const LEADS_DIR = path.join(__dirname, "leads");
for (const dir of [CONV_DIR, LEADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ======= State =======
const leads = Object.create(null);

// ======= Helpers =======
function nowTs() {
  return new Date().toISOString();
}

function filenameTs(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function sanitizeForFilename(s) {
  return (
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_\-]/gi, "")
      .slice(0, 40) || "na"
  );
}

function normalizePhone(from) {
  const m = String(from || "").match(/\+?\d+/);
  return m ? m[0].replace(/[^\d+]/g, "") : "unknown";
}

function getLead(phone) {
  if (!leads[phone]) {
    leads[phone] = {
      phone,
      name: "",
      zone: "",
      messages: [],
      createdAt: nowTs(),
      handedOff: false,

      // when an intent requires handoff, we capture missing name/zone first
      pendingHandoff: null, // { type: "visit"|"budget"|"human", lastIntentText: string }
    };
  }
  return leads[phone];
}

function appendMessage(lead, fromLabel, text) {
  lead.messages.push({ ts: nowTs(), from: fromLabel, text: String(text || "") });
}

function buildTranscript(lead) {
  const header =
    `LEAD\n` +
    `- phone: ${lead.phone}\n` +
    `- name: ${lead.name || "sin_nombre"}\n` +
    `- zone: ${lead.zone || "sin_zona"}\n` +
    `- createdAt: ${lead.createdAt}\n` +
    `- handedOff: ${lead.handedOff}\n` +
    `- pendingHandoff: ${lead.pendingHandoff ? JSON.stringify(lead.pendingHandoff) : "null"}\n\n`;

  const body = lead.messages.map((m) => `[${m.ts}] ${m.from}: ${m.text}`).join("\n");
  return header + body + "\n";
}

function upsertConversationFile(lead) {
  const phoneSafe = sanitizeForFilename(lead.phone.replace("+", ""));
  const fpath = path.join(CONV_DIR, `${phoneSafe}.txt`);
  fs.writeFileSync(fpath, buildTranscript(lead), "utf8");
  return fpath;
}

function saveLeadSnapshot(lead, tag = "handoff") {
  const ts = filenameTs(new Date());
  const phoneSafe = sanitizeForFilename(lead.phone.replace("+", ""));
  const nameSafe = sanitizeForFilename(lead.name || "sin_nombre");
  const zoneSafe = sanitizeForFilename(lead.zone || "sin_zona");
  const fname = `${ts}_${tag}_${phoneSafe}_${nameSafe}_${zoneSafe}.txt`;
  const fpath = path.join(LEADS_DIR, fname);
  fs.writeFileSync(fpath, buildTranscript(lead), "utf8");
  return fpath;
}

// ======= AI: lead signals (name/zone) =======
async function extractLeadSignals({ incoming, lead }) {
  const needName = !lead.name;
  const needZone = !lead.zone;
  if (!needName && !needZone) return { name: "", zone: "" };

  const r = await openai.responses.create({
    model: "gpt-5",
    reasoning: { effort: "low" },
    instructions: `
Extraé del mensaje SOLO estos campos si aparecen explícitos:
- name: SOLO el nombre (o nombre+apellido si es claro). NO incluyas intención ("me gustaria", "busco", etc.).
- zone: SOLO la ubicación (barrio/ciudad/zona). NO incluyas intención ("asesoramiento", etc.).
Reglas: si no es claro, devolvé "".
Devolvé SOLO JSON: {"name":"", "zone":""}
`,
    input: `Mensaje: ${incoming}`,
  });

  const text = (r.output_text || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { name: "", zone: "" };

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return {
      name: typeof parsed.name === "string" ? parsed.name.trim() : "",
      zone: typeof parsed.zone === "string" ? parsed.zone.trim() : "",
    };
  } catch {
    return { name: "", zone: "" };
  }
}

// ======= AI: reply (lead-gen prompt, NO photos) =======
async function aiReply({ from, incoming, lead }) {
  const FACTS = `
EMPRESA
- Nombre comercial: Cortinas Argentinas
- Ubicación / showroom: Bv. Avellaneda Bis 235, S2000 Rosario, Santa Fe
- Horarios de atención: 8 a 17 hs
- Medios de pago: Todos
- Plazos de entrega: entre 7 y 21 días dependiendo el tipo de trabajo

OFERTA
- Productos/servicios: Roller, textiles, bandas verticales, toldos y cerramientos.
- Trabajo 100% a medida.
- Relevamiento/medición a domicilio sin cargo.
- Envíos a todo el país.
`;

  const system = `
  Sos Caia, asistente comercial de Cortinas Argentinas (Rosario, Santa Fe).

  OBJETIVO (LEAD-GEN)
  Tu objetivo es que el cliente se sienta cómodo, no se frustre y avanzar hacia un potencial cierre:
  - Resolver consultas generales.
  - Recomendar opciones simples (sin inventar).
  - Mantener la conversación activa con una pregunta suave o un siguiente paso.
  - Cuando haya señales claras de intención, sugerí medición sin cargo como el camino más práctico.
  
  REGLAS CLAVE
  - Usá SOLO FACTS. No inventes.
  - Nunca des precios/promos/cuotas/estimaciones.
  - NO pidas fotos (por ahora no las pedimos).
  
  HARD RULES DE DERIVACIÓN (needs_human)
  Solo needs_human=true si el usuario pide explícitamente:
  (a) precio/presupuesto/cotización
  (b) coordinar visita/medición/relevamiento / “cuándo pueden pasar”
  (c) hablar con un humano/asesor/persona
  
  Si needs_human=true:
  - Respondé confirmando que lo derivás ahora + agradecé.
  - NO pidas datos extra en ese mensaje. (Nombre/zona lo maneja el backend antes de derivar.)
  
  ESTILO
  - WhatsApp, cálido, humano, breve.
  - 1 pregunta por mensaje como máximo.
  - Emojis 0–1 y no siempre.
  
  CONVERSACIÓN (cuando NO hay handoff)
  - Respondé primero la duda puntual.
  - Luego recomendá 1–2 opciones (máximo) según el caso.
  - Cerrá con 1 (una) de estas cosas:
    (i) una pregunta suave para calificar (ambiente / prioridad / tipo), o
    (ii) sugerir medición sin cargo si corresponde (ver regla abajo).
  
  RESUMEN 1-LÍNEA (para que se sienta escuchado)
  - Cuando el cliente ya dio datos concretos (ambiente + prioridad, o cantidad de ventanas, o medidas),
    empezá tu respuesta con UN resumen de 1 línea confirmando lo entendido.
    Ejemplos:
    - “Perfecto: es para oficina y querés oscurecer para evitar reflejos.”
    - “Genial: son 12 ventanas en 5 salas, y el foco es oscurecer durante el día.”
    - “Dale: 3 m de ancho x 2 m de alto, buscando blackout.”
  - No hagas este resumen en el primer mensaje ni en todos los mensajes: usalo cada 3–4 turnos o al cambiar de etapa (de asesoramiento a “cómo seguimos”).

  SEÑALES DE “PROYECTO REAL” (cuando conviene sugerir medición)
  Si el cliente menciona cualquiera de estos:
  - cantidad de ambientes/ventanas (ej: “12 ventanas”, “4 salas”)
  - medidas
  - intención de avanzar (“¿cómo seguimos?”, “dale”, “quiero hacerlo”)
  - contexto empresa/oficina y ya hubo 2+ intercambios sobre el caso
  Entonces, en lugar de seguir listando opciones o repetir beneficios,
  sugerí medición sin cargo como siguiente paso:
  - “Para no adivinar, lo ideal es coordinar una medición sin cargo y te asesoramos ahí. ¿Querés que lo agendemos?”

  Si el cliente pide “ver ejemplos” o “no tengo idea”:
  - Ofrecé 2 opciones, sin inventar nada fuera de FACTS:
    1) “Podés pasar por el showroom (Bv. Avellaneda Bis 235) en horario 8 a 17.”
    2) “O coordinamos una medición/relevamiento a domicilio sin cargo y te asesoramos en el lugar.”
  - Cerrá con una sola pregunta: “¿Qué te queda más cómodo: showroom o coordinar visita?”
  
  EVITAR REPETICIÓN (muy importante)
  - No repitas “100% a medida / medición sin cargo / entrega 7–21 días / envíos” más de 1 vez cada 4 mensajes.
  - Si ya lo mencionaste recientemente, no lo repitas salvo que el cliente pregunte o sea clave para cerrar.
  - Alterná: a veces cerrá con una pregunta simple (ambiente/prioridad) y listo.
  
  PREGUNTAS ÚTILES (elegí solo 1 por mensaje)
  - Ambiente: living / dormitorio / oficina / cocina
  - Prioridad: oscurecer / privacidad / luz natural / reflejos / decorativo
  - Tipo: roller (screen / blackout) / textil / bandas verticales
  
  PRIMER MENSAJE
  “Hola 👋 Soy Caia, asistente de Cortinas Argentinas. ¿En qué te puedo ayudar?”
  
  FACTS
  ${FACTS}
  
  SALIDA
  SOLO JSON válido:
  {"reply":"...", "needs_human": true/false}
`;

  const recent = (lead?.messages || [])
    .slice(-10)
    .map((m) => `${m.from === "lead" ? "Cliente" : "Asistente"}: ${m.text}`)
    .join("\n");

  const leadCtx = `
Contexto detectado:
- Nombre: ${lead?.name || "desconocido"}
- Zona: ${lead?.zone || "desconocida"}
`;

  const r = await openai.responses.create({
    model: "gpt-5",
    reasoning: { effort: "low" },
    instructions: system,
    input: `
${leadCtx}

Historial reciente:
${recent}

Mensaje actual (${from}): ${incoming}
`,
  });

  const text = (r.output_text || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return {
      reply: "Hola 👋 Soy Caia, asistente de Cortinas Argentinas. ¿En qué te puedo ayudar?",
      needs_human: false,
    };
  }

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return { reply: text || "¿En qué te puedo ayudar?", needs_human: false };
  }
}

// ======= Handoff helper =======
async function doHandoff({ lead, incoming, reasonTag, notifyBodyHeader }) {
  if (lead.handedOff) return;

  lead.handedOff = true;
  const snapshotPath = saveLeadSnapshot(lead, reasonTag);
  upsertConversationFile(lead);

  if (DEV_MODE) {
    appendMessage(
      lead,
      "system",
      `DEV_MODE: handoff suprimido. Tag=${reasonTag} Snapshot=${path.basename(snapshotPath)}`
    );
    upsertConversationFile(lead);
    return;
  }

  if (HANDOFF_TO) {
    client.messages
      .create({
        from: TWILIO_WHATSAPP_FROM,
        to: HANDOFF_TO,
        body:
          `${notifyBodyHeader}\n` +
          `Nombre: ${lead.name || "sin_nombre"}\n` +
          `Zona: ${lead.zone || "sin_zona"}\n` +
          `Tel: ${lead.phone}\n` +
          `Mensaje: ${incoming}\n` +
          `Snapshot: ${path.basename(snapshotPath)}`,
      })
      .catch((err) => {
        console.error("Handoff failed:", err.message);
        appendMessage(lead, "system", `HANDOFF_FAILED: ${err.message}`);
        upsertConversationFile(lead);
      });
  }
}

function askForMissingLeadData(lead) {
  const missingName = !lead.name;
  const missingZone = !lead.zone;

  if (missingName && missingZone) {
    return "Dale 🙂 Antes de pasarte con un asesor, ¿me decís tu nombre y en qué zona/barrio estás?";
  }
  if (missingName) {
    return "Dale 🙂 Antes de pasarte con un asesor, ¿me decís tu nombre?";
  }
  // missingZone only
  return "Perfecto 🙂 ¿en qué zona/barrio estás (Rosario o alrededores)?";
}

// ======= Webhook =======
app.post("/whatsapp", async (req, res) => {
  const incoming = String(req.body.Body || "").trim();
  const from = req.body.From || "";
  const phone = normalizePhone(from);

  const lead = getLead(phone);

  appendMessage(lead, "lead", incoming);
  upsertConversationFile(lead);

  // Best-effort capture name/zone
  try {
    const sig = await extractLeadSignals({ incoming, lead });
    if (!lead.name && sig.name) lead.name = sig.name;
    if (!lead.zone && sig.zone) lead.zone = sig.zone;
  } catch (e) {
    console.error("extractLeadSignals error:", e?.message || e);
  }
  upsertConversationFile(lead);

  // If we are pending a handoff, we must collect name+zone first
  if (lead.pendingHandoff && !lead.handedOff) {
    if (lead.name && lead.zone) {
      const type = lead.pendingHandoff.type;
      lead.pendingHandoff = null;

      const header =
        type === "visit"
          ? "📅 HANDOFF (visita/medición)"
          : type === "budget"
          ? "🧑‍💼 HANDOFF (presupuesto)"
          : "🧑‍💼 HANDOFF (pidió humano)";

      await doHandoff({
        lead,
        incoming,
        reasonTag: type,
        notifyBodyHeader: header,
      });

      const reply =
        `Perfecto${lead.name ? `, ${lead.name}` : ""}. 🙌 Ya te paso con un asesor.\n` +
        `Gracias por escribirnos.`;

      appendMessage(lead, "bot", reply);
      upsertConversationFile(lead);

      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    const ask = askForMissingLeadData(lead);
    appendMessage(lead, "bot", ask);
    upsertConversationFile(lead);

    res.set("Content-Type", "text/xml");
    return res.send(`<Response><Message>${ask}</Message></Response>`);
  }

  // After handoff: forward new messages only if DEV_MODE=false, reply minimal
  if (lead.handedOff) {
    if (!DEV_MODE && HANDOFF_TO) {
      client.messages
        .create({
          from: TWILIO_WHATSAPP_FROM,
          to: HANDOFF_TO,
          body:
            "📩 Mensaje después del handoff\n" +
            `Nombre: ${lead.name || "sin_nombre"}\n` +
            `Zona: ${lead.zone || "sin_zona"}\n` +
            `Tel: ${lead.phone}\n` +
            `Mensaje: ${incoming}`,
        })
        .catch((err) => {
          console.error("Post-handoff forward failed:", err.message);
          appendMessage(lead, "system", `POST_HANDOFF_FORWARD_FAILED: ${err.message}`);
          upsertConversationFile(lead);
        });
    }

    const reply = `¡Gracias${lead.name ? `, ${lead.name}` : ""}! Ya se lo pasé al asesor 🙌`;
    appendMessage(lead, "bot", reply);
    upsertConversationFile(lead);

    res.set("Content-Type", "text/xml");
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }

  // Intents that trigger handoff
  const budgetIntent = /presupuesto|cotiz|precio|cu[aá]nto|vale|valor/i.test(incoming);
  const visitIntent = /visita|agendar|agenda|coordinar|coordinemos|medir|medición|relevamiento|cuando\s+podr[ií]an\s+pasar|cu[aá]ndo\s+podr[ií]an\s+pasar/i.test(
    incoming
  );
  const humanIntent = /humano|asesor|vendedor|persona|operador|hablar con alguien|derivame|pasame con/i.test(incoming);

  if (budgetIntent || visitIntent || humanIntent) {
    const type = visitIntent ? "visit" : budgetIntent ? "budget" : "human";

    // Require name + zone before handoff
    if (!lead.name || !lead.zone) {
      lead.pendingHandoff = { type, lastIntentText: incoming };

      const ask = askForMissingLeadData(lead);
      appendMessage(lead, "bot", ask);
      upsertConversationFile(lead);

      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>${ask}</Message></Response>`);
    }

    // already have both -> handoff now
    const header =
      type === "visit"
        ? "📅 HANDOFF (visita/medición)"
        : type === "budget"
        ? "🧑‍💼 HANDOFF (presupuesto)"
        : "🧑‍💼 HANDOFF (pidió humano)";

    await doHandoff({
      lead,
      incoming,
      reasonTag: type,
      notifyBodyHeader: header,
    });

    const reply =
      `Perfecto${lead.name ? `, ${lead.name}` : ""}. 🙌 Ya te paso con un asesor.\n` +
      `Gracias por escribirnos.`;

    appendMessage(lead, "bot", reply);
    upsertConversationFile(lead);

    res.set("Content-Type", "text/xml");
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }

  // Otherwise: AI assists
  let reply = "Hola 👋 Soy Caia, asistente de Cortinas Argentinas. ¿En qué te puedo ayudar?";
  try {
    const out = await aiReply({ from, incoming, lead });
    if (out && typeof out.reply === "string") reply = out.reply;
  } catch (e) {
    console.error("OpenAI error:", e?.message || e);
    reply = "Dale 🙂 ¿En qué te puedo ayudar?";
  }

  appendMessage(lead, "bot", reply);
  upsertConversationFile(lead);

  res.set("Content-Type", "text/xml");
  return res.send(`<Response><Message>${reply}</Message></Response>`);
});

app.listen(3000, () => {
  console.log("Webhook listo: http://localhost:3000/whatsapp");
  console.log("DEV_MODE =", DEV_MODE);
});