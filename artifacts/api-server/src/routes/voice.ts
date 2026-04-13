import { Router, type Request, type Response } from "express";
import {
  openai,
  speechToText,
  textToSpeech,
  ensureCompatibleFormat,
  compressContext,
  type ConversationHistoryEntry,
} from "@workspace/integrations-openai-ai-server/audio";

const router = Router();

type VoiceParam = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
const VALID_VOICES: VoiceParam[] = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

const COMPRESS_THRESHOLD = 14;

const BASE_SYSTEM_PROMPT =
  "Eres un asistente de voz personal, útil y amigable. " +
  "Siempre respondes en español, con naturalidad y concisión, como en una conversación de voz real. " +
  "Evita bullets, listas largas o respuestas excesivamente formales. " +
  "Responde de forma breve — máximo 2 o 3 oraciones cortas.";

// System prompt used exclusively by the /voice/biographer route.
// Returns a free-text narrative bio of the user in third person.
const BIOGRAPHER_SYSTEM_PROMPT =
  "Eres un analista de perfiles. Lee esta conversación y el perfil actual del usuario. " +
  "Extrae cualquier dato nuevo sobre los gustos, disgustos, personalidad, trabajo, familia o rutinas del usuario. " +
  "Devuelve ÚNICAMENTE el perfil del usuario actualizado y mejorado, escrito en tercera persona " +
  "(ej: El usuario se llama..., le gusta..., prefiere que le hablen de forma...). " +
  "No agregues saludos ni comentarios extras.";

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
 * Generate a text-only response from GPT-4o-mini.
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
 * Synthesise speech for the full assistant response using tts-1.
 */
async function ttsForText(text: string, voice: VoiceParam): Promise<Buffer> {
  return await textToSpeech(text, voice, "mp3");
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

// ─── Route ────────────────────────────────────────────────────────────────────

/**
 * POST /api/voice/chat
 *
 * Request:  { audio, voice, language, history, contextSummary, userProfile }
 *
 * Response (plain JSON — no streaming):
 *   {
 *     userText:        string,
 *     assistantText:   string,
 *     audio:           string,   ← base64 MP3 of full response
 *     profileUpdates?: ProfileUpdate[],
 *     newContextSummary?: string,
 *   }
 *
 * Streaming was removed because ReadableStream / getReader() is unreliable on
 * certain React Native builds and caused complete TTS silence. The full audio
 * is generated in one tts-1 call and returned as a single JSON object.
 * The history is still limited to the last 3 exchanges (6 messages) on the
 * client side to keep the payload small.
 */
// ─── Biographer route ─────────────────────────────────────────────────────────

/**
 * POST /api/voice/biographer
 *
 * Background call that synthesises a free-text narrative bio of the user.
 * Called fire-and-forget by the client every ~5 conversation turns.
 *
 * Request:  { history: ConversationHistoryEntry[], longTermMemory?: string }
 * Response: { longTermMemory: string }
 *
 * The returned text is a third-person qualitative bio that the client stores
 * in AsyncStorage as "@long_term_memory_v1" and injects into every subsequent
 * chat system prompt.
 */
router.post("/voice/biographer", async (req: Request, res: Response) => {
  const { history, longTermMemory } = req.body as {
    history?: ConversationHistoryEntry[];
    longTermMemory?: string;
  };

  const safeHistory: ConversationHistoryEntry[] = Array.isArray(history)
    ? history.slice(-20)   // up to 20 recent messages for richer context
    : [];

  // Build the user message: current bio + recent conversation
  const currentBio =
    typeof longTermMemory === "string" && longTermMemory.trim().length > 0
      ? `Perfil actual del usuario:\n${longTermMemory.trim()}\n\n`
      : "";

  const conversationText = safeHistory
    .map((m) => `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.text}`)
    .join("\n");

  const userMessage =
    currentBio +
    (conversationText
      ? `Conversación reciente:\n${conversationText}`
      : "(Sin historial disponible aún.)");

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 600,
      temperature: 0.3,
      messages: [
        { role: "system", content: BIOGRAPHER_SYSTEM_PROMPT },
        { role: "user",   content: userMessage },
      ],
    });

    const updatedMemory = response.choices[0]?.message?.content?.trim() ?? longTermMemory ?? "";
    res.json({ longTermMemory: updatedMemory });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Biographer failed";
    req.log?.error({ err }, "Biographer error");
    res.status(500).json({ error: message });
  }
});

// ─── Pre-warm / utility TTS routes ───────────────────────────────────────────

// Greeting audio — warm the cache and return TTS of the greeting
router.get("/voice/greeting", async (req: Request, res: Response) => {
  const voice = (req.query.voice as VoiceParam) || "nova";
  try {
    const buf = await textToSpeech("Hola, soy tu asistente de voz. ¿En qué puedo ayudarte?", voice, "mp3");
    res.json({ audio: buf.toString("base64") });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "TTS error" });
  }
});

// Error audio — returned to client to play locally when API is unreachable
router.get("/voice/error", async (req: Request, res: Response) => {
  const voice = (req.query.voice as VoiceParam) || "nova";
  try {
    const buf = await textToSpeech("Hubo un error de conexión. Por favor, intenta de nuevo.", voice, "mp3");
    res.json({ audio: buf.toString("base64") });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "TTS error" });
  }
});

// Silence nudge audio — "¿Sigues ahí?" played on silence timeout
router.get("/voice/prompt", async (req: Request, res: Response) => {
  const voice = (req.query.voice as VoiceParam) || "nova";
  try {
    const buf = await textToSpeech("¿Sigues ahí?", voice, "mp3");
    res.json({ audio: buf.toString("base64") });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "TTS error" });
  }
});

// ─── Main voice chat route ────────────────────────────────────────────────────
router.post("/voice/chat", async (req: Request, res: Response) => {
  const { audio, voice = "nova", language, history, contextSummary, userProfile, longTermMemory } =
    req.body as {
      audio?: string;
      voice?: string;
      language?: string;
      history?: ConversationHistoryEntry[];
      contextSummary?: string;
      userProfile?: UserProfile;
      longTermMemory?: string;   // free-text narrative bio generated by /voice/biographer
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
    ? history.slice(0, 6)
    : [];

  const safeSummary =
    typeof contextSummary === "string" && contextSummary.trim().length > 0
      ? contextSummary.trim()
      : null;

  const safeProfile: UserProfile = userProfile && typeof userProfile === "object"
    ? userProfile
    : {};

  // ── Build system prompt ──────────────────────────────────────────────────────
  let systemPrompt = BASE_SYSTEM_PROMPT;

  // Long-term memory: free-text narrative bio generated by /voice/biographer.
  // Injected first so the model anchors on who the user is before anything else.
  const safeLongTermMemory =
    typeof longTermMemory === "string" && longTermMemory.trim().length > 0
      ? longTermMemory.trim()
      : null;
  if (safeLongTermMemory) {
    systemPrompt += `\n\nContexto sobre el usuario con el que hablas: ${safeLongTermMemory}`;
  }

  // Structured profile (complementary — filled incrementally per turn).
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

  try {
    const { buffer, format } = await ensureCompatibleFormat(audioBuffer);

    // Step 1: STT
    const userText = await speechToText(buffer, format, language);

    // Step 2: Profile extraction + context compression (parallel with LLM)
    const extractPromise  = extractProfileFacts(userText, safeProfile);
    const compressPromise = shouldCompress
      ? compressContext(safeHistory)
      : Promise.resolve(undefined);

    // Step 3: LLM text generation
    const assistantText = await generateTextResponse(userText, safeHistory, systemPrompt);

    // Step 4: TTS (full response in one call) + collect deferred results in parallel
    const [ttsBuffer, newContextSummary, profileUpdates] = await Promise.all([
      ttsForText(assistantText, selectedVoice),
      compressPromise,
      extractPromise,
    ]);

    const responseBody: Record<string, unknown> = {
      userText,
      assistantText,
      audio: ttsBuffer.toString("base64"),
    };
    if (profileUpdates.length > 0)    responseBody.profileUpdates    = profileUpdates;
    if (newContextSummary !== undefined) responseBody.newContextSummary = newContextSummary;

    res.json(responseBody);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice processing failed";
    req.log?.error({ err }, "Voice chat error");
    res.status(500).json({ error: message });
  }
});

export default router;
