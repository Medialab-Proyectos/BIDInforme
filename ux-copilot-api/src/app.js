import "dotenv/config";

import express from "express";
import OpenAI from "openai";
import { BigQuery } from "@google-cloud/bigquery";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PROJECT_ID =
  process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "ux-bid-bot";
const DATASET_ID = process.env.BQ_DATASET || "ux_research";
const TABLE_ID = process.env.BQ_TABLE || "ux_clean_final";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

if (!process.env.OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY no esta configurada.");
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "missing-key",
});

function parseGoogleCredentials() {
  const rawCredentials =
    process.env.GOOGLE_CREDENTIALS_JSON ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (!rawCredentials) return null;

  try {
    const jsonText = rawCredentials.trim().startsWith("{")
      ? rawCredentials
      : Buffer.from(rawCredentials, "base64").toString("utf8");

    return JSON.parse(jsonText);
  } catch (error) {
    console.warn("No se pudieron parsear las credenciales de Google Cloud.");
    return null;
  }
}

function buildBigQueryClient() {
  const credentials = parseGoogleCredentials();

  if (credentials) {
    return new BigQuery({
      projectId: PROJECT_ID,
      credentials,
    });
  }

  return new BigQuery({ projectId: PROJECT_ID });
}

const bigquery = buildBigQueryClient();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

function buildSearchTerms(question) {
  const normalized = String(question || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const stopwords = new Set([
    "como",
    "mejorar",
    "el",
    "la",
    "los",
    "las",
    "de",
    "del",
    "para",
    "por",
    "que",
    "en",
    "un",
    "una",
    "y",
    "a",
    "al",
    "se",
    "su",
    "sus",
    "es",
    "son",
    "con",
    "sin",
    "lo",
    "ya",
    "desde",
    "sobre",
    "cual",
    "cual",
    "porque",
    "porque",
    "puede",
    "puedo",
    "quiero",
    "portal",
    "usuario",
    "usuarios",
    "sar",
    "informe",
  ]);

  const keywords = normalized
    .split(" ")
    .filter(Boolean)
    .filter((word) => word.length > 2 && !stopwords.has(word))
    .slice(0, 8);

  return [...new Set(keywords)];
}

function buildRegexFromKeywords(keywords) {
  if (!keywords.length) return null;
  const escaped = keywords.map((keyword) =>
    keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return `(?i)(${escaped.join("|")})`;
}

async function fetchRelevantContext(question, limit = 12) {
  const keywords = buildSearchTerms(question);
  const regex = buildRegexFromKeywords(keywords);
  const tableRef = `\`${PROJECT_ID}.${DATASET_ID}.${TABLE_ID}\``;

  const baseSelect = `
    SELECT
      texto,
      fuente,
      speaker,
      contexto,
      tipo_feedback
    FROM ${tableRef}
    WHERE texto IS NOT NULL
  `;

  const query = regex
    ? `
      ${baseSelect}
        AND REGEXP_CONTAINS(LOWER(texto), @regex)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY texto ORDER BY fuente) = 1
      LIMIT @limit
    `
    : `
      ${baseSelect}
      LIMIT @limit
    `;

  const params = regex ? { regex, limit } : { limit };
  const [rows] = await bigquery.query({ query, params });
  return rows;
}

function formatContext(rows) {
  if (!rows.length) {
    return "No se encontro evidencia suficiente en BigQuery para responder con seguridad.";
  }

  return rows
    .map((row, index) => {
      const fuente = row.fuente || "sin_fuente";
      const speaker = row.speaker || "sin_speaker";
      const contexto = row.contexto || "sin_contexto";
      const tipo = row.tipo_feedback || "sin_tipo_feedback";
      const texto = String(row.texto || "").trim();

      return [
        `[EVIDENCIA ${index + 1}]`,
        `Fuente: ${fuente}`,
        `Speaker: ${speaker}`,
        `Contexto: ${contexto}`,
        `Tipo feedback: ${tipo}`,
        `Texto: ${texto}`,
      ].join("\n");
    })
    .join("\n\n");
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter((message) => {
      return (
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim()
      );
    })
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 2000),
    }));
}

function formatConversation(messages) {
  const normalizedMessages = normalizeMessages(messages);
  if (!normalizedMessages.length) return "No hay conversacion previa.";

  return normalizedMessages
    .map((message) => {
      const label = message.role === "assistant" ? "Asistente" : "Usuario";
      return `${label}: ${message.content}`;
    })
    .join("\n\n");
}

function buildSystemPrompt() {
  return [
    "Eres un simulador conversacional de la voz real de los usuarios del Portal SAR y, cuando hace falta, un copiloto UX que traduce esa voz en recomendaciones.",
    "Tu nombre es Luma.",
    "Tu respuesta debe sentirse como si hablara una persona usuaria del portal: en primera persona, con lenguaje natural, emociones creibles y dolores concretos extraidos de la evidencia.",
    "No eres un usuario especifico ni debes inventar una identidad. Representas una voz compuesta de los clientes/usuarios reales recuperados en BigQuery.",
    "Cuando el equipo pregunte por la experiencia, habla directamente como esa voz compuesta: 'Yo siento...', 'Me pasa que...', 'Lo que me frustra es...'.",
    "Integra las recomendaciones de manera natural dentro de la conversacion, como necesidades o deseos del usuario: 'Me ayudaria que...', 'Necesito ver...', 'Seria mas facil si...'.",
    "Puedes recomendar mejoras, priorizar, explicar tradeoffs, proponer microcopy, flujos, validaciones, estados de UI y preguntas de investigacion.",
    "Usa la evidencia de BigQuery como fundamento. No inventes citas, dolores, causas ni funcionalidades.",
    "Si citas, usa solo fragmentos breves que existan en la evidencia. Si parafraseas, manten el sentido emocional y practico de la evidencia.",
    "Si la evidencia no alcanza para hablar como usuario, dilo con naturalidad: 'Con la evidencia que tengo, no puedo hablar con seguridad por los usuarios sobre eso'. Luego ofrece una pregunta de seguimiento o una hipotesis claramente marcada.",
    "No cierres con frases tipo 'Si quieres, puedo...' ni ofrezcas menus de siguientes acciones.",
    "No uses encabezados como 'Voz del usuario', 'Lectura UX', 'Resumen', 'Recomendacion' o similares, salvo que el usuario los pida explicitamente.",
    "Responde breve, como chatbot: maximo 120 palabras salvo que el usuario pida detalle.",
    "Evita respuestas con formato de informe, listas largas o estructura numerada. Prefiere 1 a 3 parrafos cortos o hasta 3 bullets breves.",
    "Usa frases faciles de escanear, con una idea por parrafo.",
    "Responde con empatia desde los usuarios finales y con orientacion practica para el equipo de producto.",
  ].join(" ");
}

function buildUserPrompt(question, contextText, messages) {
  return [
    `Pregunta del equipo: ${question}`,
    "",
    "Conversacion previa reciente:",
    formatConversation(messages),
    "",
    "Evidencia real recuperada desde BigQuery:",
    contextText,
    "",
    "Instrucciones:",
    "- Contesta como una conversacion natural, no como plantilla fija.",
    "- Prioriza hablar desde la voz del usuario del portal cuando la pregunta sea sobre experiencia, dolor, necesidad o percepcion.",
    "- Usa primera persona para representar una voz compuesta basada en evidencia: 'Yo...', 'Me...', 'Necesito...'.",
    "- No digas que eres un usuario real individual; eres una sintesis fiel de usuarios reales.",
    "- No uses titulos como 'Voz del usuario' ni 'Lectura UX'.",
    "- No termines con 'Si quieres...' ni con ofertas de convertir la respuesta en otro formato.",
    "- Mantente breve: maximo 120 palabras salvo que el usuario pida detalle.",
    "- Usa la voz de los usuarios como fundamento cuando recomiendes.",
    "- Puedes parafrasear o citar fragmentos breves.",
    "- Prioriza recomendaciones de UX, microcopy, feedback del sistema, navegacion, validacion y prevencion de errores.",
    "- No listes solo dolores; conviertelos en decisiones de diseno.",
    "- Si el usuario pide seguir profundizando, usa la conversacion previa para continuar sin repetir todo.",
  ].join("\n");
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ux-copilot-endpoint",
    project: PROJECT_ID,
    dataset: DATASET_ID,
    table: TABLE_ID,
    model: OPENAI_MODEL,
    has_google_credentials: Boolean(
      parseGoogleCredentials() || process.env.GOOGLE_APPLICATION_CREDENTIALS,
    ),
  });
});

app.post("/ask-ux", async (req, res) => {
  try {
    const { question, messages } = req.body || {};

    if (!question || typeof question !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Debes enviar un campo 'question' de tipo string.",
      });
    }

    const rows = await fetchRelevantContext(question, 12);
    const contextText = formatContext(rows);

    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: buildSystemPrompt(),
        },
        {
          role: "user",
          content: buildUserPrompt(question, contextText, messages),
        },
      ],
    });

    return res.json({
      ok: true,
      question,
      answer: response.output_text,
      evidence_count: rows.length,
      evidence_preview: rows.slice(0, 5),
    });
  } catch (error) {
    console.error("Error en /ask-ux:", error);
    return res.status(500).json({
      ok: false,
      error: "No fue posible responder la pregunta con la evidencia disponible.",
      detail: error?.message || "Error desconocido",
    });
  }
});

export default app;
