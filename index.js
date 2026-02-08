// index.js — Render + Twilio timeout-proof (FAST_ACK) + Debug endpoints (AI-only state) + Low-latency AI
// - Responds 200 OK immediately (prevents Twilio 11200 timeouts)
// - Replies to the lead via Twilio API in background
// - DEV_MODE=true suppresses ALL outbound messages (no quota usage) but still logs + debug endpoints
// - NO REGEX for name/zone/intents: AI extracts + drives conversation
// - Handoff only when user explicitly asks for price/budget OR to coordinate a visit/measurement
// - Never handoff unless we have: (1) what the lead wants (intentSummary), (2) name, (3) zone
// - Fixes timeouts: greet-shortcut (no AI), smaller model, shorter context, 1 retry with even smaller context/model
// - Pending handoff: if user asked earlier and we were collecting missing fields, complete handoff once ready

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

// AI models (fast defaults)
const AI_MODEL_MAIN = process.env.AI_MODEL_MAIN || "gpt-5-mini";
const AI_MODEL_RETRY = process.env.AI_MODEL_RETRY || "gpt-5-nano";

// ======= Health endpoints =======
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) =>
  res.status(200).json({
    ok: true,
    dev_mode: DEV_MODE,
    fast_ack: FAST_ACK,
    has_openai_key: Boolean(process.env.OPENAI_API_KEY),
    has_twilio_sid: Boolean(process.env.TWILIO_ACCOUNT_SID),
    has_handoff_to: Boolean(HANDOFF_TO),
    debug_token_set: Boolean(DEBUG_TOKEN),
    ai_model_main: AI_MODEL_MAIN,
    ai_model_retry: AI_MODEL_RETRY,
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
      intentSummary: "", // what the lead wants (minimal summary)
      messages: [],
      createdAt: nowTs(),
      handedOff: false,
      // pendingHandoff: { type: "visit"|"price", requestedAt: ts }
      pendingHandoff: null,
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

  const body = lead.messages.map((m) => `[${m.ts}] ${m.from}: ${m.text}`).join("\n");
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

function safeHandoffType(t) {
  return t === "visit" || t === "price" ? t : null;
}

// Basic short greeting detection (NO REGEX extractions; just avoid AI call on trivial greetings)
function isTrivialGreeting(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return true;
  // very short message -> treat as greeting / opener to avoid AI latency
  if (t.length <= 3) return true;
  // common greetings
  const greetings = [
    "hola",
    "holaa",
    "holaaa",
    "buenas",
    "buen día",
    "buen dia",
    "buenos días",
    "buenos dias",
    "buenas tardes",
    "buenas noches",
    "hello",
    "hi",
    "hey",
    "👋",
  ];
  return greetings.includes(t);
}

function askMissingForHandoff(lead) {
  // One question max. If two fields missing, ask both in one sentence.
  const missingName = !lead.name;
  const missingZone = !lead.zone;
  const missingIntent = !lead.intentSummary;

  // Priority: intentSummary first (what wants) because you explicitly asked for it before handoff.
  if (missingIntent && (missingName || missingZone)) {
    return "Perfecto 🙂 Antes de derivarte, ¿me contás brevemente qué estás buscando (tipo de cortina y para qué ambiente) y tu nombre + zona/barrio?";
  }
  if (missingIntent) {
    return "Perfecto 🙂 Antes de derivarte, ¿me contás brevemente qué estás buscando (tipo de cortina y para qué ambiente)?";
  }
  if (missingName && missingZone) {
    return "Dale 🙂 Antes de pasarte con un asesor, ¿me decís tu nombre y en qué zona/barrio estás?";
  }
  if (missingName) return "Dale 🙂 Antes de pasarte con un asesor, ¿me decís tu nombre?";
  if (missingZone) return "Perfecto 🙂 ¿En qué zona/barrio estás (Rosario o alrededores)?";
  return "Perfecto 🙂";
}

// ======= Debug endpoints (optional) =======
function requireDebugToken(req, res) {
  if (!DEBUG_TOKEN) return true; // open if not set
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

// ======= AI Brain (single call returns reply + state updates + handoff intent) =======
async function aiDecideAndReply({ incoming, lead, opts }) {
  const { model, historyN } = opts;

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

  const recent = (lead?.messages || [])
    .slice(-historyN)
    .map((m) => `${m.from === "lead" ? "Cliente" : m.from === "bot" ? "Asistente" : "Sistema"}: ${m.text}`)
    .join("\n");

  const state = {
    name: lead?.name || "",
    zone: lead?.zone || "",
    intentSummary: lead?.intentSummary || "",
    pendingHandoff: lead?.pendingHandoff || null,
    handedOff: Boolean(lead?.handedOff),
  };

  const instructions = `
Sos Caia, asistente comercial de Cortinas Argentinas (Rosario, Santa Fe).

TU TRABAJO (en una sola respuesta JSON):
1) Responder al cliente de forma cálida, breve y útil.
2) EXTRAER/ACTUALIZAR estado si aparece explícito:
   - name: nombre del cliente (solo nombre o nombre+apellido si es claro).
   - zone: barrio/ciudad/zona.
   - intentSummary: 1 línea con qué quiere el cliente (ej: "Cortinas blackout para oficina, reducir reflejos y mantener luz").
   Regla: si no es claro, dejalo vacío y NO inventes.
3) Detectar si el cliente pidió EXPLÍCITAMENTE:
   - handoff_intent = "price" si pide precio/presupuesto/cotización.
   - handoff_intent = "visit" si pide coordinar visita/medición/relevamiento/agendar.
   - handoff_intent = "none" en cualquier otro caso.
4) Si handoff_intent != "none", antes de derivar necesitamos 3 cosas:
   - intentSummary NO vacío
   - name NO vacío
   - zone NO vacío
   Si falta algo, NO derivar. En ese caso, reply debe pedir SOLO lo que falta, cordial, 1 pregunta máximo.
   Si están las 3 cosas, reply debe confirmar derivación y agradecer (sin pedir más datos).

REGLAS DE ESTILO:
- WhatsApp, humano, breve.
- Máximo 1 pregunta por mensaje.
- Emojis 0–1 (no siempre).
- No repetir beneficios cada mensaje.

REGLAS DE NEGOCIO:
- Usá SOLO FACTS, no inventes.
- Nunca des precios/promos/cuotas/estimaciones.
- No pidas fotos.

SALIDA: SOLO JSON válido, sin texto extra:
{
  "reply": "...",
  "name": "",
  "zone": "",
  "intentSummary": "",
  "handoff_intent": "none" | "price" | "visit"
}
`;

  const r = await openai.responses.create({
    model,
    reasoning: { effort: "low" },
    instructions,
    input: `FACTS:\n${FACTS}\n\nESTADO_ACTUAL:\n${JSON.stringify(state)}\n\nHISTORIAL_RECIENTE:\n${recent}\n\nMENSAJE_CLIENTE:\n${incoming}`,
  });

  const text = (r.output_text || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("ai_output_not_json");

  const parsed = JSON.parse(text.slice(start, end + 1));

  const handoff_intent =
    parsed.handoff_intent === "price" || parsed.handoff_intent === "visit" || parsed.handoff_intent === "none"
      ? parsed.handoff_intent
      : "none";

  return {
    reply: typeof parsed.reply === "string" ? parsed.reply.trim() : "",
    name: typeof parsed.name === "string" ? parsed.name.trim() : "",
    zone: typeof parsed.zone === "string" ? parsed.zone.trim() : "",
    intentSummary: typeof parsed.intentSummary === "string" ? parsed.intentSummary.trim() : "",
    handoff_intent,
  };
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
        `Tel: ${lead.phone}\n` +
        `Mensaje: ${incoming}\n` +
        `Snapshot: ${path.basename(snapshotPath)}`
    );
  }
}

// ======= Main processing (async after FAST_ACK) =======
async function processInbound({ incoming, from, lead }) {
  // 0) If already handed off: acknowledge + optionally forward to HANDOFF_TO
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
          `Interés: ${lead.intentSummary || "sin_contexto"}\n` +
          `Tel: ${lead.phone}\n` +
          `Mensaje: ${incoming}`
      );
    }
    return;
  }

  // 1) If we are collecting for a previous explicit handoff request, we can complete it once ready
  const pendingType = safeHandoffType(lead.pendingHandoff?.type);

  // 2) Avoid AI call for trivial greetings/openers (reduces timeouts massively)
  if (isTrivialGreeting(incoming)) {
    // If we are pending a handoff and missing fields, ask what's missing instead of generic hello.
    if (pendingType) {
      const ask = askMissingForHandoff(lead);
      appendMessage(lead, "bot", ask);
      upsertConversationFile(lead);
      await sendWhatsApp(from, ask);
      return;
    }

    const hello = "Hola 👋 Soy Caia, asistente de Cortinas Argentinas. ¿En qué te puedo ayudar?";
    appendMessage(lead, "bot", hello);
    upsertConversationFile(lead);
    await sendWhatsApp(from, hello);
    return;
  }

  // 3) AI decides reply + extracts state + detects explicit handoff intent
  let out = null;

  try {
    out = await withTimeout(
      aiDecideAndReply({
        incoming,
        lead,
        opts: { model: AI_MODEL_MAIN, historyN: 8 },
      }),
      6500
    );
  } catch (e1) {
    console.error("aiDecideAndReply main error:", e1?.message || e1);
    // One retry: shorter context + faster model
    try {
      out = await withTimeout(
        aiDecideAndReply({
          incoming,
          lead,
          opts: { model: AI_MODEL_RETRY, historyN: 4 },
        }),
        4500
      );
    } catch (e2) {
      console.error("aiDecideAndReply retry error:", e2?.message || e2);
      const fallback =
        pendingType
          ? askMissingForHandoff(lead)
          : "Disculpá, tuve un problema técnico. ¿Me contás brevemente qué tipo de cortina buscás y para qué ambiente?";
      appendMessage(lead, "bot", fallback);
      upsertConversationFile(lead);
      await sendWhatsApp(from, fallback);
      return;
    }
  }

  // 4) Apply state updates (only if non-empty; never overwrite existing)
  if (!lead.name && out.name) lead.name = out.name;
  if (!lead.zone && out.zone) lead.zone = out.zone;
  if (!lead.intentSummary && out.intentSummary) lead.intentSummary = out.intentSummary;

  upsertConversationFile(lead);

  // 5) Determine if we should handoff:
  // - either the user explicitly asked now (out.handoff_intent)
  // - or we are in a pendingHandoff flow from an earlier explicit request
  const aiHandoff = safeHandoffType(out.handoff_intent === "price" ? "price" : out.handoff_intent === "visit" ? "visit" : null);
  const activeHandoffType = pendingType || aiHandoff;

  if (activeHandoffType) {
    const ready = Boolean(lead.intentSummary && lead.name && lead.zone);

    if (!ready) {
      // We do NOT handoff. Ensure we remember pending and ask missing info.
      if (!lead.pendingHandoff) {
        lead.pendingHandoff = { type: activeHandoffType, requestedAt: nowTs() };
      }

      // Prefer AI reply if it exists; otherwise deterministic ask for missing.
      const reply = (out.reply && out.reply.trim()) ? out.reply.trim() : askMissingForHandoff(lead);

      appendMessage(lead, "bot", reply);
      upsertConversationFile(lead);
      await sendWhatsApp(from, reply);
      return;
    }

    // Ready -> confirm to lead + perform handoff
    // (We send a deterministic confirmation to avoid any AI mistake here.)
    const confirm =
      `Perfecto${lead.name ? `, ${lead.name}` : ""}. 🙌 Ya te paso con un asesor.\n` +
      `Gracias por escribirnos.`;

    appendMessage(lead, "bot", confirm);
    upsertConversationFile(lead);
    await sendWhatsApp(from, confirm);

    // clear pending and handoff
    lead.pendingHandoff = null;
    upsertConversationFile(lead);

    await doHandoff({ lead, incoming, reasonTag: activeHandoffType });
    return;
  }

  // 6) Normal (no handoff): reply
  const reply =
    (out.reply && out.reply.trim()) ||
    "Hola 👋 Soy Caia, asistente de Cortinas Argentinas. ¿En qué te puedo ayudar?";

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

  if (FAST_ACK) {
    res.status(200).send("OK");

    processInbound({ incoming, from, lead }).catch((e) => {
      console.error("processInbound error:", e?.message || e);
      appendMessage(lead, "system", `PROCESS_INBOUND_ERR: ${e?.message || e}`);
      upsertConversationFile(lead);
    });
    return;
  }

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
  console.log("DEBUG_TOKEN set =", Boolean(DEBUG_TOKEN));
  console.log("AI_MODEL_MAIN =", AI_MODEL_MAIN);
  console.log("AI_MODEL_RETRY =", AI_MODEL_RETRY);
});