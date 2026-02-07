// index.js — Render + Twilio timeout-proof (FAST_ACK) + Debug endpoints
// - Responds 200 OK immediately (prevents Twilio 11200 timeouts)
// - Replies to the lead via Twilio API in background
// - DEV_MODE=true suppresses ALL outbound messages by default (no quota usage)
// - Toggle REPLY_TO_LEAD_IN_DEV=true to test WhatsApp replies while DEV_MODE=true
// - Debug endpoints to inspect in-memory conversations on Render (optional token)

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const twilio = require("twilio");
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886";
const HANDOFF_TO = process.env.HANDOFF_TO; // whatsapp:+549...

const DEV_MODE = String(process.env.DEV_MODE || "true").toLowerCase() === "true";

// FAST_ACK: reply 200 OK immediately to Twilio to avoid 11200
const FAST_ACK = String(process.env.FAST_ACK || "true").toLowerCase() === "true";

// In DEV_MODE, outbound is suppressed by default. You can allow replying to the lead:
const REPLY_TO_LEAD_IN_DEV =
  String(process.env.REPLY_TO_LEAD_IN_DEV || "false").toLowerCase() === "true";

// Optional: protect debug endpoints
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || "";

const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ======= Health endpoints (Render checks) =======
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) =>
  res.status(200).json({
    ok: true,
    dev_mode: DEV_MODE,
    fast_ack: FAST_ACK,
    reply_to_lead_in_dev: REPLY_TO_LEAD_IN_DEV,
    has_openai_key: Boolean(process.env.OPENAI_API_KEY),
    has_twilio_sid: Boolean(process.env.TWILIO_ACCOUNT_SID),
  })
);

// ======= Folders (ephemeral on Render, still useful in Logs) =======
const CONV_DIR = path.join(__dirname, "conversations");
const LEADS_DIR = path.join(__dirname, "leads");
for (const dir of [CONV_DIR, LEADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ======= State (in-memory) =======
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

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function canSendOutbound() {
  // DEV_MODE: suppress outbound unless explicitly allowed
  if (!DEV_MODE) return true;
  return REPLY_TO_LEAD_IN_DEV;
}

async function sendWhatsApp(toWhatsApp, body) {
  if (!toWhatsApp) return;

  if (!canSendOutbound()) {
    console.log("DEV_MODE: outbound suppressed. Would send to:", toWhatsApp, "Body:", body);
    return;
  }

  return client.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: toWhatsApp,
    body,
  });
}

// ======= Debug endpoints (optional) =======
function requireDebugToken(req, res) {
  if (!DEBUG_TOKEN) return true; // if not set, it's open
  const t = String(req.query.token || req.headers["x-debug-token"] || "");
  if (t !== DEBUG_TOKEN) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

app.get("/debug/leads", (req, res) => {
  if (!requireDebugToken(req, res)) return;

  const items = Object.values(leads).map((l) => ({
    phone: l.phone,
    name: l.name || "",
    zone: l.zone || "",
    createdAt: l.createdAt,
    handedOff: Boolean(l.handedOff),
    pendingHandoff: l.pendingHandoff || null,
    messagesCount: (l.messages || []).length,
    lastAt: (l.messages || []).length ? l.messages[l.messages.length - 1].ts : null,
    lastFrom: (l.messages || []).length ? l.messages[l.messages.length - 1].from : null,
    lastText: (l.messages || []).length ? l.messages[l.messages.length - 1].text : null,
  }));

  items.sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")));
  res.json({ ok: true, count: items.length, leads: items });
});

app.get("/debug/conversation", (req, res) => {
  if (!requireDebugToken(req, res)) return;

  const phone = String(req.query.phone || "").trim();
  if (!phone) return res.status(400).json({ ok: false, error: "missing ?phone=..." });

  const lead = leads[phone];
  if (!lead) return res.status(404).json({ ok: false, error: "lead_not_found" });

  res.json({
    ok: true,
    lead: {
      phone: lead.phone,
      name: lead.name || "",
      zone: lead.zone || "",
      createdAt: lead.createdAt,
      handedOff: Boolean(lead.handedOff),
      pendingHandoff: lead.pendingHandoff || null,
    },
    messages: lead.messages || [],
  });
});

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
- Que el cliente se sienta cómodo y avanzar hacia un cierre.
- Resolver consultas generales.
- Recomendar 1–2 opciones simples.
- Mantener conversación con 1 pregunta suave o siguiente paso.
- Con señales claras de intención, sugerí medición sin cargo como camino práctico.

REGLAS CLAVE
- Usá SOLO FACTS. No inventes.
- Nunca des precios/promos/cuotas/estimaciones.
- NO pidas fotos.

HARD RULES DE DERIVACIÓN (needs_human)
Solo needs_human=true si el usuario pide explícitamente:
(a) precio/presupuesto/cotización
(b) coordinar visita/medición/relevamiento / “cuándo pueden pasar”
(c) hablar con un humano/asesor/persona

Si needs_human=true:
- Respondé confirmando que lo derivás ahora + agradecé.
- NO pidas datos extra (nombre/zona lo gestiona el backend).

ESTILO
- WhatsApp, cálido, breve.
- 1 pregunta máximo.
- Emojis 0–1 y no siempre.

EVITAR REPETICIÓN
- No repitas beneficios más de 1 vez cada 4 mensajes.

PRIMER MENSAJE
Hola 👋 Soy Caia, asistente de Cortinas Argentinas. ¿En qué te puedo ayudar?

FACTS
${FACTS}

SALIDA
SOLO JSON: {"reply":"...", "needs_human": true/false}
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
    input: `${leadCtx}\nHistorial:\n${recent}\n\nMensaje actual (${from}): ${incoming}`,
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
async function doHandoff({ lead, incoming, reasonTag }) {
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
    await sendWhatsApp(
      HANDOFF_TO,
      `${reasonTag === "visit" ? "📅" : "🧑‍💼"} HANDOFF (${reasonTag})\n` +
        `Nombre: ${lead.name || "sin_nombre"}\n` +
        `Zona: ${lead.zone || "sin_zona"}\n` +
        `Tel: ${lead.phone}\n` +
        `Mensaje: ${incoming}\n` +
        `Snapshot: ${path.basename(snapshotPath)}`
    );
  }
}

function askForMissingLeadData(lead) {
  const missingName = !lead.name;
  const missingZone = !lead.zone;

  if (missingName && missingZone) {
    return "Dale 🙂 Antes de pasarte con un asesor, ¿me decís tu nombre y en qué zona/barrio estás?";
  }
  if (missingName) return "Dale 🙂 Antes de pasarte con un asesor, ¿me decís tu nombre?";
  return "Perfecto 🙂 ¿en qué zona/barrio estás (Rosario o alrededores)?";
}

// ======= Main processing (async, after FAST_ACK) =======
async function processInbound({ incoming, from, lead }) {
  // Intents that trigger handoff
  const budgetIntent = /presupuesto|cotiz|precio|cu[aá]nto|vale|valor/i.test(incoming);
  const visitIntent =
    /visita|agendar|agenda|coordinar|coordinemos|medir|medición|relevamiento|cuando\s+podr[ií]an\s+pasar|cu[aá]ndo\s+podr[ií]an\s+pasar/i.test(
      incoming
    );
  const humanIntent = /humano|asesor|vendedor|persona|operador|hablar con alguien|derivame|pasame con/i.test(incoming);

  const needsHandoff = budgetIntent || visitIntent || humanIntent || (lead.pendingHandoff && !lead.handedOff);

  // If we need name/zone for handoff flow, try a fast extraction (timeout-protected)
  if (needsHandoff && (!lead.name || !lead.zone)) {
    try {
      const sig = await withTimeout(extractLeadSignals({ incoming, lead }), 2000);
      if (!lead.name && sig.name) lead.name = sig.name;
      if (!lead.zone && sig.zone) lead.zone = sig.zone;
      upsertConversationFile(lead);
    } catch (e) {
      console.log("extractLeadSignals timeout/err:", e?.message || e);
    }
  }

  // If we were pending handoff, continue collecting
  if (lead.pendingHandoff && !lead.handedOff) {
    if (lead.name && lead.zone) {
      const type = lead.pendingHandoff.type;
      lead.pendingHandoff = null;

      await doHandoff({ lead, incoming, reasonTag: type });

      const reply =
        `Perfecto${lead.name ? `, ${lead.name}` : ""}. 🙌 Ya te paso con un asesor.\n` +
        `Gracias por escribirnos.`;

      appendMessage(lead, "bot", reply);
      upsertConversationFile(lead);

      await sendWhatsApp(from, reply);
      return;
    } else {
      const ask = askForMissingLeadData(lead);

      appendMessage(lead, "bot", ask);
      upsertConversationFile(lead);

      await sendWhatsApp(from, ask);
      return;
    }
  }

  // If handoff already happened: minimal reply, optionally forward to HANDOFF_TO (only when DEV_MODE=false)
  if (lead.handedOff) {
    const reply = `¡Gracias${lead.name ? `, ${lead.name}` : ""}! Ya se lo pasé al asesor 🙌`;

    appendMessage(lead, "bot", reply);
    upsertConversationFile(lead);

    await sendWhatsApp(from, reply);

    if (!DEV_MODE && HANDOFF_TO) {
      await sendWhatsApp(
        HANDOFF_TO,
        "📩 Mensaje después del handoff\n" +
          `Nombre: ${lead.name || "sin_nombre"}\n` +
          `Zona: ${lead.zone || "sin_zona"}\n` +
          `Tel: ${lead.phone}\n` +
          `Mensaje: ${incoming}`
      );
    }
    return;
  }

  // New handoff intent
  if (budgetIntent || visitIntent || humanIntent) {
    const type = visitIntent ? "visit" : budgetIntent ? "budget" : "human";

    if (!lead.name || !lead.zone) {
      lead.pendingHandoff = { type, lastIntentText: incoming };
      const ask = askForMissingLeadData(lead);

      appendMessage(lead, "bot", ask);
      upsertConversationFile(lead);

      await sendWhatsApp(from, ask);
      return;
    }

    await doHandoff({ lead, incoming, reasonTag: type });

    const reply =
      `Perfecto${lead.name ? `, ${lead.name}` : ""}. 🙌 Ya te paso con un asesor.\n` +
      `Gracias por escribirnos.`;

    appendMessage(lead, "bot", reply);
    upsertConversationFile(lead);

    await sendWhatsApp(from, reply);
    return;
  }

  // Otherwise: AI assists (timeout-protected)
  let reply = "Hola 👋 Soy Caia, asistente de Cortinas Argentinas. ¿En qué te puedo ayudar?";

  try {
    const out = await withTimeout(aiReply({ from, incoming, lead }), 9000);
    if (out && typeof out.reply === "string") reply = out.reply;
  } catch (e) {
    console.log("aiReply timeout/err:", e?.message || e);
    reply = "Dale 🙂 ¿En qué te puedo ayudar?";
  }

  appendMessage(lead, "bot", reply);
  upsertConversationFile(lead);

  await sendWhatsApp(from, reply);
}

// ======= Webhook =======
app.post("/whatsapp", (req, res) => {
  console.log("INBOUND /whatsapp", {
    at: new Date().toISOString(),
    from: req.body.From,
    body: req.body.Body,
  });

  const incoming = String(req.body.Body || "").trim();
  const from = req.body.From || "";
  const phone = normalizePhone(from);

  const lead = getLead(phone);

  appendMessage(lead, "lead", incoming);
  upsertConversationFile(lead);

  // FAST_ACK: respond immediately so Twilio never times out
  if (FAST_ACK) {
    res.status(200).send("OK");

    // continue async (do not await)
    processInbound({ incoming, from, lead }).catch((e) => {
      console.error("processInbound error:", e?.message || e);
      appendMessage(lead, "system", `PROCESS_INBOUND_ERR: ${e?.message || e}`);
      upsertConversationFile(lead);
    });

    return;
  }

  // Fallback (non-FAST_ACK): synchronous (not recommended)
  (async () => {
    try {
      await processInbound({ incoming, from, lead });
    } catch (e) {
      console.error("sync processInbound error:", e?.message || e);
    } finally {
      res.status(200).send("OK");
    }
  })();
});

// ======= Listen (Render uses PORT) =======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook listo en puerto ${PORT}`);
  console.log("DEV_MODE =", DEV_MODE);
  console.log("FAST_ACK =", FAST_ACK);
  console.log("REPLY_TO_LEAD_IN_DEV =", REPLY_TO_LEAD_IN_DEV);
  console.log("DEBUG_TOKEN set =", Boolean(DEBUG_TOKEN));
});