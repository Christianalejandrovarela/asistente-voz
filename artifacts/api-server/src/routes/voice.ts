import { Router, type Request, type Response } from "express";
import {
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

function parseAudio(audio: unknown): Buffer | null {
  if (!audio || typeof audio !== "string") return null;
  try {
    return Buffer.from(audio, "base64");
  } catch {
    return null;
  }
}

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
 *   history       – array of { role, text } conversation turns (up to 30)
 *   contextSummary – (optional) compressed summary from a previous session
 *
 * Response body:
 *   audio            – base64-encoded MP3 response
 *   userText         – transcribed user speech
 *   assistantText    – AI text response
 *   newContextSummary – (optional) new summary — only returned when the history
 *                       has been compressed. The client should store this, clear
 *                       its local history, and send it as contextSummary on future turns.
 */
router.post("/voice/chat", async (req: Request, res: Response) => {
  const { audio, voice = "nova", language, history, contextSummary } = req.body as {
    audio?: string;
    voice?: string;
    language?: string;
    history?: ConversationHistoryEntry[];
    contextSummary?: string;
  };

  const audioBuffer = parseAudio(audio);
  if (!audioBuffer) {
    res.status(400).json({ error: "audio field is required and must be a base64 string" });
    return;
  }

  const selectedVoice: VoiceParam = VALID_VOICES.includes(voice as VoiceParam)
    ? (voice as VoiceParam)
    : "nova";

  // Accept up to 30 history entries (15 full turns). Compression kicks in at 14.
  const safeHistory: ConversationHistoryEntry[] = Array.isArray(history)
    ? history.slice(0, 30)
    : [];

  const safeSummary = typeof contextSummary === "string" && contextSummary.trim().length > 0
    ? contextSummary.trim()
    : null;

  // Build system prompt — embed any compressed summary from a previous session
  let systemPrompt = BASE_SYSTEM_PROMPT;
  if (safeSummary) {
    systemPrompt +=
      `\n\n[Contexto previo (resumen de la sesión anterior)]:\n${safeSummary}`;
  }

  const today = new Date().toLocaleDateString("es-ES", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  systemPrompt += `\n\nLa fecha de hoy es ${today}.`;

  // Decide whether to compress in this turn.
  // When threshold is reached, compression runs in parallel with the AI response
  // → zero extra latency for the user.
  const shouldCompress = safeHistory.length >= COMPRESS_THRESHOLD;

  try {
    const { buffer, format } = await ensureCompatibleFormat(audioBuffer);

    const [userText, { transcript: assistantText, audioResponse }, newContextSummary] =
      await Promise.all([
        speechToText(buffer, format, language),
        voiceChat(buffer, selectedVoice, format, "mp3", safeHistory, systemPrompt),
        shouldCompress ? compressContext(safeHistory) : Promise.resolve(undefined),
      ]);

    res.json({
      audio: audioResponse.toString("base64"),
      userText,
      assistantText,
      ...(newContextSummary !== undefined ? { newContextSummary } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice processing failed";
    req.log?.error({ err }, "Voice chat error");
    res.status(500).json({ error: message });
  }
});

export default router;
