// index.js — DEMO STABLE (FAST_ACK) + AI-first + queue-per-lead + smart timeouts/retry + light prompt
// Goals:
// - Always 200 OK fast to Twilio (prevents 11200)
// - AI drives conversation + extracts state (name/zone/intentSummary) + detects explicit handoff intent
// - Never handoff unless we have: intentSummary + name + zone AND user explicitly asked price/visit
// - Per-lead queue to prevent race conditions (messages arriving close together)
// - Timeouts increased + retry with backoff
// - Fallback on timeout is CONTEXTUAL (visit/price) and asks only what's missing
// - Debug endpoints to inspect in-memory conversations

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const twilio = require("twilio");
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ======= Config =======
const TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886";
const HANDOFF_TO = process.env.HANDOFF_TO || ""; // whatsapp:+549...

const DEV_MODE = String(process.env.DEV_MODE || "true").toLowerCase() === "true";
const FAST_ACK = String(process.env.FAST_ACK || "true").toLowerCase() === "true";
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || "";

// Models: set via env (demo-friendly)
// Example:
// MODEL_FAST=gpt-5-mini
// MODEL_SMART=gpt-5
const MODEL_FAST = process.env.MODEL_FAST || "gpt-5-mini";
const MODEL_SMART = process.env.MODEL_SMART || "gpt-5";

// Timeouts (ms) — demo stable
const AI_TIMEOUT_MAIN = Number(process.env.AI_TIMEOUT_MAIN || 20000); // 20s
const AI_TIMEOUT_RETRY = Number(process.env.AI_TIMEOUT_RETRY || 12000); // 12s
const AI_BACKOFF_MS = Number(process.env.AI_BACKOFF_MS || 350); // retry backoff
const AI_HISTORY_LIMIT = Number(process.env.AI_HISTORY_LIMIT || 8); // last N messages

// ======= Health endpoints =======
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) =>
  res.status(200).json({
    ok: true,
    dev_mode: DEV_MODE,
    fast_ack: FAST_ACK,
    model_fast: MODEL_FAST,
    model_smart: MODEL_SMART,
    ai_timeout_main: AI_TIMEOUT_MAIN,
    ai_timeout_retry: AI_TIMEOUT_RETRY,
    has_openai_key: Boolean(process.env.OPENAI_API_KEY),
    has_twilio_sid: Boolean(process.env.TWILIO_ACCOUNT_SID),
    has_handoff_to: Boolean(HANDOFF_TO),
    debug_token_set: Boolean(DEBUG_TOKEN),
  })
);

// ======= Folders (ephemeral on Render) =======
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
      intentSummary: "",
      availability: "", // <-- NUEVO
      messages: [],
      createdAt: nowTs(),
      handedOff: false,
      pendingHandoff: null,
      _queue: Promise.resolve(),
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
    `- intentSummary: ${lead.intentSummary || "sin_contexto"}\n` +
    `- createdAt: ${lead.createdAt}\n` +
    `- handedOff: ${lead.handedOff}\n` +
    `- pendingHandoff: ${lead.pendingHandoff ? JSON.stringify(lead.pendingHandoff) : "null"}\n\n`;

  const body = (lead.messages || []).map((m) => `[${m.ts}] ${m.from}: ${m.text}`).join("\n");
  return header + body + "\n";
}

function upsertConversationFile(lead) {
  const phoneSafe = sanitizeForFilename(String(lead.phone || "").replace("+", ""));
  const fpath = path.join(CONV_DIR, `${phoneSafe}.txt`);
  fs.writeFileSync(fpath, buildTranscript(lead), "utf8");
  return fpath;
}

function saveLeadSnapshot(lead, tag = "handoff") {
  const ts = filenameTs(new Date());
  const phoneSafe = sanitizeForFilename(String(lead.phone || "").replace("+", ""));
  const nameSafe = sanitizeForFilename(lead.name || "sin_nombre");
  const zoneSafe = sanitizeForFilename(lead.zone || "sin_zona");
  const intentSafe = sanitizeForFilename(lead.intentSummary || "sin_contexto");
  const fname = `${ts}_${tag}_${phoneSafe}_${nameSafe}_${zoneSafe}_${intentSafe}.txt`;
  const fpath = path.join(LEADS_DIR, fname);
  fs.writeFileSync(fpath, buildTranscript(lead), "utf8");
  return fpath;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

async function sendWhatsApp(toWhatsApp, body) {
  if (!toWhatsApp) return;

  if (DEV_MODE) {
    console.log("DEV_MODE: outbound suppressed. Would send to:", toWhatsApp, "Body:", body);
    return;
  }

  return client.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: toWhatsApp,
    body,
  });
}

// Per-lead queue: avoids race conditions on rapid inbound messages
function enqueueLead(lead, fn) {
  lead._queue = lead._queue
    .then(fn)
    .catch((e) => {
      console.error("enqueueLead task error:", e?.message || e);
      appendMessage(lead, "system", `QUEUE_TASK_ERR: ${e?.message || e}`);
      upsertConversationFile(lead);
    });
  return lead._queue;
}

// ======= Debug endpoints =======
function requireDebugToken(req, res) {
  if (!DEBUG_TOKEN) return true;
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
    intentSummary: l.intentSummary || "",
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
      intentSummary: lead.intentSummary || "",
      createdAt: lead.createdAt,
      handedOff: Boolean(lead.handedOff),
      pendingHandoff: lead.pendingHandoff || null,
    },
    messages: lead.messages || [],
  });
});

app.get("/debug/last.txt", (req, res) => {
  if (!requireDebugToken(req, res)) return;

  const all = Object.values(leads || {});
  res.set("Content-Type", "text/plain; charset=utf-8");
  if (!all.length) return res.status(200).send("No leads in memory yet.\n");

  let latest = null;
  for (const l of all) {
    const msgs = l.messages || [];
    const lastTs = msgs.length ? msgs[msgs.length - 1].ts : "";
    if (!latest) latest = { lead: l, lastTs };
    else if (lastTs > (latest.lastTs || "")) latest = { lead: l, lastTs };
  }
  return res.status(200).send(buildTranscript(latest.lead));
});

// ======= AI Brain (light prompt) =======
function buildFactsCompact() {
  // Compact = faster
  return [
    "Cortinas Argentinas (Rosario, Santa Fe).",
    "Showroom: Bv. Avellaneda Bis 235. Horario: 8 a 17.",
    "Hacemos Roller, textiles, bandas verticales, toldos y cerramientos. Todo a medida.",
    "Medición/relevamiento a domicilio sin cargo. Envíos a todo el país.",
    "No damos precios/estimaciones por chat.",
  ].join("\n");
}

function summarizeHistory(lead) {
  const msgs = (lead?.messages || []).slice(-AI_HISTORY_LIMIT);
  return msgs
    .map((m) => `${m.from === "lead" ? "Cliente" : m.from === "bot" ? "Asistente" : "Sistema"}: ${m.text}`)
    .join("\n");
}

async function aiDecideAndReply({ incoming, lead, model }) {
  const facts = buildFactsCompact();

  const state = {
    name: lead?.name || "",
    zone: lead?.zone || "",
    intentSummary: lead?.intentSummary || "",
    availability: lead?.availability || "", // <-- NUEVO
    pendingHandoff: lead?.pendingHandoff || null,
    handedOff: Boolean(lead?.handedOff),
  };

  // Ultra-light instructions to reduce latency
  const instructions = `
Sos Caia, asistente comercial de Cortinas Argentinas.

Tarea:
- Responder breve y útil.
- Actualizar estado SOLO si el cliente lo dijo explícito:
  name, zone, intentSummary (1 línea de qué busca), availability (día/horario posible).
- Detectar si el cliente pidió EXPLÍCITAMENTE:
  handoff_intent="price" (precio/presupuesto/cotización) o "visit" (coordinar visita/medición/agendar).
  Si no lo pidió explícito: "none".

Reglas: no inventar, no precios, no fotos, 0-1 emoji.

IMPORTANTE (handoff):
- Para "price": NO derivar aún a menos que existan intentSummary + name + zone.
- Para "visit": NO derivar aún a menos que existan intentSummary + name + zone + availability.

Si falta algo y handoff_intent != "none":
- reply debe pedir SOLO lo que falta.
- Máximo 1 pregunta.

Si YA están todos los datos requeridos (según el tipo):
- reply NO debe hacer preguntas.
- reply debe: confirmar (1 línea) + decir “Te contactamos por este mismo WhatsApp en breve” + agradecer.

Salida: JSON estricto:
{"reply":"...","name":"","zone":"","intentSummary":"","availability":"","handoff_intent":"none|price|visit"}
`.trim();

  const input = `
FACTS:
${facts}

ESTADO_ACTUAL:
${JSON.stringify(state)}

HISTORIAL:
${summarizeHistory(lead)}

MENSAJE_CLIENTE:
${incoming}
`.trim();

  const r = await openai.responses.create({
    model,
    reasoning: { effort: "low" },
    instructions,
    input,
  });

  const text = (r.output_text || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("ai_output_not_json");

  const parsed = JSON.parse(text.slice(start, end + 1));
  return {
    reply: typeof parsed.reply === "string" ? parsed.reply.trim() : "",
    name: typeof parsed.name === "string" ? parsed.name.trim() : "",
    zone: typeof parsed.zone === "string" ? parsed.zone.trim() : "",
    intentSummary: typeof parsed.intentSummary === "string" ? parsed.intentSummary.trim() : "",
    availability: typeof parsed.availability === "string" ? parsed.availability.trim() : "", // <-- NUEVO
    handoff_intent: parsed.handoff_intent,
  };
}

function applyStateFromAI(lead, out) {
  if (!lead.name && out.name) lead.name = out.name;
  if (!lead.zone && out.zone) lead.zone = out.zone;
  if (!lead.intentSummary && out.intentSummary) lead.intentSummary = out.intentSummary;
  if (!lead.availability && out.availability) lead.availability = out.availability; // <-- NUEVO
}

// Fallback ONLY when AI timed out.
// Keep it contextual and ask only what's missing.
// (This is the “demo stability” lever.)
function timeoutFallbackReply(lead, incoming) {
  const t = String(incoming || "").toLowerCase();

  const looksLikeVisit =
    t.includes("visita") || t.includes("medicion") || t.includes("medición") || t.includes("relevamiento") || t.includes("agendar") || t.includes("coordinar");

  const looksLikePrice =
    t.includes("precio") || t.includes("presupuesto") || t.includes("cotiz") || t.includes("cuanto") || t.includes("cuánto") || t.includes("valor");

  // If user is asking for visit/price, we must collect: intentSummary + name + zone
  const missing = [];
  if (!lead.intentSummary) missing.push("qué estás buscando (en 1 frase)");
  if (!lead.name) missing.push("tu nombre");
  if (!lead.zone) missing.push("tu zona/barrio");

  if (looksLikeVisit || looksLikePrice) {
    if (missing.length) {
      // Ask only ONE thing (best next missing), to keep WhatsApp natural
      const ask = missing[0];
      return `Dale 🙂 Para ayudarte con eso, ¿me decís ${ask}?`;
    }
    // If we somehow have all required, we can confirm
    return `Perfecto${lead.name ? `, ${lead.name}` : ""}. 🙌 Ya te paso con un asesor. ¡Gracias!`;
  }

  // Normal fallback if not visit/price
  if (!lead.intentSummary) {
    return "Disculpá, tuve un problema técnico. ¿Me contás brevemente qué tipo de cortina buscás y para qué ambiente?";
  }

  // If we have intentSummary, ask a single useful qualifier question
  return "Disculpá, tuve un problema técnico. ¿Tu prioridad es más oscurecer, bajar reflejos o ganar privacidad?";
}

// ======= Handoff =======
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
        `Interés: ${lead.intentSummary || "sin_contexto"}\n` +
        (reasonTag === "visit" ? `Disponibilidad: ${lead.availability || "sin_disponibilidad"}\n` : "") +
        `Tel: ${lead.phone}\n` +
        `Mensaje: ${incoming}\n` +
        `Snapshot: ${path.basename(snapshotPath)}`
    );
  }
}

// ======= Main processing (async after FAST_ACK) =======
async function processInbound({ incoming, from, lead }) {
  // If already handed off: acknowledge + optionally forward
  if (lead.handedOff) {
    const reply = `¡Gracias${lead.name ? `, ${lead.name}` : ""}! Ya se lo pasé al asesor 🙌`;
    appendMessage(lead, "bot", reply);
    upsertConversationFile(lead);
    await sendWhatsApp(from, reply);
    return;
  }

  // AI decide (main + retry)
  let out = null;
  const startedAt = Date.now();

  try {
    out = await withTimeout(aiDecideAndReply({ incoming, lead, model: MODEL_FAST }), AI_TIMEOUT_MAIN);
  } catch (e1) {
    console.error("aiDecideAndReply main error:", e1?.message || e1);

    await sleep(AI_BACKOFF_MS);
    try {
      out = await withTimeout(aiDecideAndReply({ incoming, lead, model: MODEL_SMART }), AI_TIMEOUT_RETRY);
    } catch (e2) {
      console.error("aiDecideAndReply retry error:", e2?.message || e2);

      const fb = timeoutFallbackReply(lead, incoming);
      appendMessage(lead, "bot", fb);
      upsertConversationFile(lead);
      await sendWhatsApp(from, fb);
      return;
    }
  } finally {
    console.log("AI latency ms:", Date.now() - startedAt);
  }

  // Apply state updates
  applyStateFromAI(lead, out);
  upsertConversationFile(lead);

  const reply = out.reply || "Hola 👋 Soy Caia, asistente de Cortinas Argentinas. ¿En qué te puedo ayudar?";

  // Detect explicit handoff request from AI
  const handoffIntent = out.handoff_intent;
  const wantsHandoff = handoffIntent === "price" || handoffIntent === "visit";

  if (wantsHandoff) {
    const ready =
      handoffIntent === "visit"
        ? Boolean(lead.intentSummary && lead.name && lead.zone && lead.availability)
        : Boolean(lead.intentSummary && lead.name && lead.zone);

    const msg = out.reply || "Perfecto 🙂";
    appendMessage(lead, "bot", msg);
    upsertConversationFile(lead);
    await sendWhatsApp(from, msg);

    if (ready) {
      await doHandoff({ lead, incoming, reasonTag: handoffIntent });
    } else {
      lead.pendingHandoff = { type: handoffIntent, requestedAt: nowTs() };
      upsertConversationFile(lead);
    }
    return;
  }

  // Normal reply
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

  // FAST_ACK to Twilio
  if (FAST_ACK) {
    res.status(200).send("OK");

    // Queue per lead (prevents overlap)
    enqueueLead(lead, async () => {
      await processInbound({ incoming, from, lead });
    });

    return;
  }

  // Non-FAST_ACK (not recommended)
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

// ======= Listen =======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook listo en puerto ${PORT}`);
  console.log("DEV_MODE =", DEV_MODE);
  console.log("FAST_ACK =", FAST_ACK);
  console.log("MODEL_FAST =", MODEL_FAST);
  console.log("MODEL_SMART =", MODEL_SMART);
  console.log("DEBUG_TOKEN set =", Boolean(DEBUG_TOKEN));
});