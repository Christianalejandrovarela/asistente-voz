import { Router, type Request, type Response } from "express";
import {
  openai,
  voiceChat,
  speechToText,
  ensureCompatibleFormat,
  compressContext,
  type ConversationHistoryEntry,
} from "@workspace/integrations-openai-ai-server/audio";

const router = Router();

type VoiceParam = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
const VALID_VOICES: VoiceParam[] = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

// Compress when conversation history reaches this many messages (turns × 2).
// Compression runs in parallel with the AI response — zero added latency.
const COMPRESS_THRESHOLD = 14;

const BASE_SYSTEM_PROMPT =
  "Eres un asistente de voz personal, útil y amigable. " +
  "Siempre respondes en español, con naturalidad y concisión, como en una conversación de voz real. " +
  "Evita bullets, listas largas o respuestas excesivamente formales.";

// ─── Profile types ────────────────────────────────────────────────────────────

interface UserProfile {
  name?: string;
  age?: number;
  location?: string;
  occupation?: string;
  interests?: string[];
  facts?: string[];
}

interface ProfileUpdate {
  field: "name" | "age" | "location" | "occupation" | "interest" | "fact";
  value: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseAudio(audio: unknown): Buffer | null {
  if (!audio || typeof audio !== "string") return null;
  try {
    return Buffer.from(audio, "base64");
  } catch {
    return null;
  }
}

function formatProfileForPrompt(profile: UserProfile): string {
  const lines: string[] = [];
  if (profile.name)       lines.push(`Nombre: ${profile.name}`);
  if (profile.age)        lines.push(`Edad: ${profile.age}`);
  if (profile.location)   lines.push(`Ubicación: ${profile.location}`);
  if (profile.occupation) lines.push(`Trabajo: ${profile.occupation}`);
  if (profile.interests?.length)
    lines.push(`Intereses: ${profile.interests.slice(-10).join(", ")}`);
  if (profile.facts?.length)
    lines.push(`Información adicional:\n${profile.facts.slice(-15).map(f => `- ${f}`).join("\n")}`);
  return lines.join("\n");
}

/**
 * Extract new personal facts from the user's transcribed message using
 * gpt-4o-mini.  Runs in parallel with voiceChat — adds zero user-facing
 * latency since voiceChat typically takes longer.
 *
 * Returns an empty array if nothing new is found or the call fails.
 */
async function extractProfileFacts(
  userText: string,
  existingProfile: UserProfile,
): Promise<ProfileUpdate[]> {
  if (userText.trim().length < 8) return [];

  const existingJson = JSON.stringify({
    name: existingProfile.name,
    age: existingProfile.age,
    location: existingProfile.location,
    occupation: existingProfile.occupation,
    interests: existingProfile.interests ?? [],
    facts: existingProfile.facts ?? [],
  });

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 256,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            `Eres un extractor de datos personales. Analiza el mensaje del usuario y extrae ÚNICAMENTE información personal NUEVA que no esté ya en el perfil conocido.\n` +
            `Perfil actual: ${existingJson}\n\n` +
            `Devuelve SOLO un array JSON válido con objetos {"field":"...","value":"..."}.\n` +
            `Campos permitidos: "name", "age", "location", "occupation", "interest", "fact".\n` +
            `Usa "interest" para gustos/hobbies/deportes/música/etc.\n` +
            `Usa "fact" para eventos de vida, posesiones, relaciones, logros.\n` +
            `Si no hay nada nuevo, devuelve []. NUNCA inventes información.`,
        },
        {
          role: "user",
          content: userText,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "[]";
    // Strip markdown code blocks if present
    const clean = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(clean) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Validate shape
    return (parsed as ProfileUpdate[]).filter(
      (u) => u && typeof u.field === "string" && typeof u.value === "string",
    );
  } catch {
    return []; // Always non-fatal
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/voice/greeting?voice=nova
 * Returns a short TTS greeting so the assistant speaks first when activated
 * with the screen off (Bluetooth button press). Cached server-side per voice.
 */
const greetingCache = new Map<string, string>(); // voice → base64-mp3

router.get("/voice/greeting", async (req: Request, res: Response) => {
  const voice = VALID_VOICES.includes(req.query.voice as VoiceParam)
    ? (req.query.voice as VoiceParam)
    : "nova";

  if (greetingCache.has(voice)) {
    res.json({ audio: greetingCache.get(voice) });
    return;
  }

  try {
    const { textToSpeech } = await import(
      "@workspace/integrations-openai-ai-server/audio"
    );
    const buffer = await textToSpeech("Dime, te escucho.", voice, "mp3");
    const base64 = buffer.toString("base64");
    greetingCache.set(voice, base64);
    res.json({ audio: base64 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "TTS failed";
    req.log?.error({ err }, "Greeting TTS error");
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/voice/transcribe
 * Whisper (gpt-4o-transcribe) speech-to-text only.
 */
router.post("/voice/transcribe", async (req: Request, res: Response) => {
  const { audio, language } = req.body as { audio?: string; language?: string };

  const audioBuffer = parseAudio(audio);
  if (!audioBuffer) {
    res.status(400).json({ error: "audio field is required and must be a base64 string" });
    return;
  }

  try {
    const { buffer, format } = await ensureCompatibleFormat(audioBuffer);
    const text = await speechToText(buffer, format, language);
    res.json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription failed";
    req.log?.error({ err }, "Transcription error");
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/voice/chat
 * Full speech-to-speech pipeline with persistent memory and context compression.
 *
 * Request body:
 *   audio         – base64-encoded audio
 *   voice         – TTS voice name (default "nova")
 *   language      – BCP-47 language code (default "es")
 *   history       – array of { role, text } conversation turns (up to 16)
 *   contextSummary – (optional) compressed summary from a previous session
 *   userProfile   – (optional) persistent user profile for long-term memory
 *
 * Response body:
 *   audio            – base64-encoded MP3 response
 *   userText         – transcribed user speech
 *   assistantText    – AI text response
 *   newContextSummary – (optional) new summary when history is compressed
 *   profileUpdates   – (optional) new facts extracted from this turn
 */
router.post("/voice/chat", async (req: Request, res: Response) => {
  const { audio, voice = "nova", language, history, contextSummary, userProfile } =
    req.body as {
      audio?: string;
      voice?: string;
      language?: string;
      history?: ConversationHistoryEntry[];
      contextSummary?: string;
      userProfile?: UserProfile;
    };

  const audioBuffer = parseAudio(audio);
  if (!audioBuffer) {
    res.status(400).json({ error: "audio field is required and must be a base64 string" });
    return;
  }

  const selectedVoice: VoiceParam = VALID_VOICES.includes(voice as VoiceParam)
    ? (voice as VoiceParam)
    : "nova";

  const safeHistory: ConversationHistoryEntry[] = Array.isArray(history)
    ? history.slice(0, 16)
    : [];

  const safeSummary =
    typeof contextSummary === "string" && contextSummary.trim().length > 0
      ? contextSummary.trim()
      : null;

  const safeProfile: UserProfile = userProfile && typeof userProfile === "object"
    ? userProfile
    : {};

  // ── Build system prompt ─────────────────────────────────────────────────────
  let systemPrompt = BASE_SYSTEM_PROMPT;

  // 1. Inject user profile (long-term memory)
  const profileText = formatProfileForPrompt(safeProfile);
  if (profileText) {
    systemPrompt +=
      `\n\n[Perfil del usuario — usa esta información para personalizar tus respuestas]:\n${profileText}`;
  }

  // 2. Inject compressed session summary (medium-term memory)
  if (safeSummary) {
    systemPrompt +=
      `\n\n[Contexto previo (resumen de la sesión anterior)]:\n${safeSummary}`;
  }

  // 3. Current date
  const today = new Date().toLocaleDateString("es-ES", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  systemPrompt += `\n\nLa fecha de hoy es ${today}.`;

  const shouldCompress = safeHistory.length >= COMPRESS_THRESHOLD;

  try {
    const { buffer, format } = await ensureCompatibleFormat(audioBuffer);

    // ── Step 1: Start voiceChat and STT in parallel ──────────────────────────
    // voiceChat processes audio → audio response (slow, 2-4 s)
    // speechToText transcribes audio → text (medium, 1-2 s)
    const voiceChatPromise = voiceChat(buffer, selectedVoice, format, "mp3", safeHistory, systemPrompt);
    const speechToTextPromise = speechToText(buffer, format, language);
    const compressPromise = shouldCompress
      ? compressContext(safeHistory)
      : Promise.resolve(undefined);

    // ── Step 2: As soon as STT resolves, start profile extraction ────────────
    // Profile extraction (gpt-4o-mini, ~300-500 ms) runs in parallel with
    // the still-running voiceChat — zero additional latency for the user.
    const userText = await speechToTextPromise;
    const extractPromise = extractProfileFacts(userText, safeProfile);

    // ── Step 3: Collect all results ──────────────────────────────────────────
    const [{ transcript: assistantText, audioResponse }, newContextSummary, profileUpdates] =
      await Promise.all([voiceChatPromise, compressPromise, extractPromise]);

    res.json({
      audio: audioResponse.toString("base64"),
      userText,
      assistantText,
      ...(newContextSummary !== undefined ? { newContextSummary } : {}),
      ...(profileUpdates.length > 0 ? { profileUpdates } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice processing failed";
    req.log?.error({ err }, "Voice chat error");
    res.status(500).json({ error: message });
  }
});

export default router;
