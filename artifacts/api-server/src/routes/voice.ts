import { Router, type Request, type Response } from "express";
import {
  openai,
  speechToText,
  ensureCompatibleFormat,
  compressContext,
  type ConversationHistoryEntry,
} from "@workspace/integrations-openai-ai-server/audio";

const router = Router();

type VoiceParam = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
const VALID_VOICES: VoiceParam[] = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

// Compress when history reaches this threshold.
const COMPRESS_THRESHOLD = 14;

const BASE_SYSTEM_PROMPT =
  "Eres un asistente de voz personal, útil y amigable. " +
  "Siempre respondes en español, con naturalidad y concisión, como en una conversación de voz real. " +
  "Evita bullets, listas largas o respuestas excesivamente formales. " +
  "Responde de forma breve — máximo 2 o 3 oraciones cortas.";

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
  try { return Buffer.from(audio, "base64"); } catch { return null; }
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
    lines.push(`Información adicional:\n${profile.facts.slice(-15).map((f) => `- ${f}`).join("\n")}`);
  return lines.join("\n");
}

/**
 * Split assistant text into short, playable sentences.
 * Returns at least one element (the full text as fallback).
 */
function splitSentences(text: string): string[] {
  // Split on . ! ? followed by whitespace (lookbehind).
  const raw = text.split(/(?<=[.!?…])\s+/);
  const sentences: string[] = [];
  let pending = "";

  for (const part of raw) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    pending = pending ? `${pending} ${trimmed}` : trimmed;
    // Emit when the pending piece is long enough to warrant its own TTS call.
    if (pending.length >= 20 || /[!?]$/.test(pending)) {
      sentences.push(pending);
      pending = "";
    }
  }
  if (pending) sentences.push(pending);
  return sentences.length > 0 ? sentences : [text.trim()];
}

/**
 * Generate a text-only response from GPT-4o-mini.
 * Fast and cheap — ideal for voice where brevity is key.
 */
async function generateTextResponse(
  userText: string,
  history: ConversationHistoryEntry[],
  systemPrompt: string,
): Promise<string> {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
    ...history.map((h) => ({
      role: h.role as "user" | "assistant",
      content: h.text,
    })),
    { role: "user", content: userText },
  ];

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: 300,
    temperature: 0.7,
  });

  return resp.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * Synthesise speech for a single sentence using tts-1 (fast).
 */
async function ttsForSentence(text: string, voice: VoiceParam): Promise<Buffer> {
  const resp = await openai.audio.speech.create({
    model: "tts-1",
    voice,
    input: text,
    response_format: "mp3",
  });
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Extract new personal facts from the user's message (runs in parallel with TTS).
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
        { role: "user", content: userText },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "[]";
    const clean = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(clean) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as ProfileUpdate[]).filter(
      (u) => u && typeof u.field === "string" && typeof u.value === "string",
    );
  } catch {
    return [];
  }
}

// ─── Streaming helper ─────────────────────────────────────────────────────────

function writeLine(res: Response, obj: object): void {
  res.write(JSON.stringify(obj) + "\n");
  // Flush immediately so the client receives each sentence ASAP.
  // Works with Express's built-in streaming (no extra middleware needed).
  if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
    (res as unknown as { flush: () => void }).flush();
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

/**
 * POST /api/voice/chat
 *
 * Request: { audio, voice, language, history, contextSummary, userProfile }
 *
 * Response: NDJSON stream
 *   {"type":"sentence","text":"...","audio":"<base64-mp3>"}  ← one per sentence
 *   {"type":"done","userText":"...","assistantText":"...","profileUpdates":[...]}
 *   {"type":"error","error":"..."}  ← only on failure
 *
 * The client plays each sentence audio as soon as it arrives, so the user
 * hears the first word 1-2 s sooner than waiting for the entire response.
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
    ? history.slice(0, 6) // accept max 3 exchanges from client
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
  const profileText = formatProfileForPrompt(safeProfile);
  if (profileText) {
    systemPrompt += `\n\n[Perfil del usuario]:\n${profileText}`;
  }
  if (safeSummary) {
    systemPrompt += `\n\n[Contexto previo]:\n${safeSummary}`;
  }
  const today = new Date().toLocaleDateString("es-ES", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  systemPrompt += `\n\nLa fecha de hoy es ${today}.`;

  const shouldCompress = safeHistory.length >= COMPRESS_THRESHOLD;

  // ── Set up streaming response ───────────────────────────────────────────────
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering

  try {
    const { buffer, format } = await ensureCompatibleFormat(audioBuffer);

    // ── Step 1: STT (transcribe audio → text) ────────────────────────────────
    const userText = await speechToText(buffer, format, language);

    // ── Step 2: Profile extraction + context compression (parallel) ───────────
    const extractPromise   = extractProfileFacts(userText, safeProfile);
    const compressPromise  = shouldCompress
      ? compressContext(safeHistory)
      : Promise.resolve(undefined);

    // ── Step 3: LLM text generation ───────────────────────────────────────────
    const assistantText = await generateTextResponse(userText, safeHistory, systemPrompt);

    // ── Step 4: Split into sentences & stream TTS one sentence at a time ──────
    const sentences = splitSentences(assistantText);

    // Pipeline: start generating sentence N+1 TTS while sentence N is being
    // sent to the client (they download it + play it ≈ 1-3s per sentence).
    let nextAudioPromise: Promise<Buffer> | null = null;

    for (let i = 0; i < sentences.length; i++) {
      const sentenceAudio = nextAudioPromise
        ? await nextAudioPromise
        : await ttsForSentence(sentences[i]!, selectedVoice);

      // Pre-generate next sentence in parallel with the client playing this one.
      nextAudioPromise =
        i + 1 < sentences.length
          ? ttsForSentence(sentences[i + 1]!, selectedVoice)
          : null;

      writeLine(res, {
        type:  "sentence",
        text:  sentences[i],
        audio: sentenceAudio.toString("base64"),
      });
    }

    // ── Step 5: Collect deferred results and send done event ──────────────────
    const [newContextSummary, profileUpdates] = await Promise.all([
      compressPromise,
      extractPromise,
    ]);

    writeLine(res, {
      type:          "done",
      userText,
      assistantText,
      ...(newContextSummary !== undefined ? { newContextSummary } : {}),
      ...(profileUpdates.length > 0 ? { profileUpdates } : {}),
    });

    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice processing failed";
    req.log?.error({ err }, "Voice chat error");
    try {
      writeLine(res, { type: "error", error: message });
      res.end();
    } catch {
      // response already ended
    }
  }
});

export default router;
