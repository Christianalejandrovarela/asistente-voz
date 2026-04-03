import { Router, type Request, type Response } from "express";
import {
  voiceChat,
  speechToText,
  ensureCompatibleFormat,
} from "@workspace/integrations-openai-ai-server/audio";

const router = Router();

type VoiceParam = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
const VALID_VOICES: VoiceParam[] = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

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
 * Whisper (gpt-4o-mini-transcribe) speech-to-text only.
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
 * Full speech-to-speech pipeline:
 *   1. Whisper (gpt-4o-mini-transcribe) → user transcript
 *   2. gpt-4o-audio-preview (via gpt-audio alias) → assistant response + MP3 audio
 * Both run in parallel to minimise latency.
 */
router.post("/voice/chat", async (req: Request, res: Response) => {
  const { audio, voice = "nova", language } = req.body as {
    audio?: string;
    voice?: string;
    language?: string;
  };

  const audioBuffer = parseAudio(audio);
  if (!audioBuffer) {
    res.status(400).json({ error: "audio field is required and must be a base64 string" });
    return;
  }

  const selectedVoice: VoiceParam = VALID_VOICES.includes(voice as VoiceParam)
    ? (voice as VoiceParam)
    : "nova";

  try {
    const { buffer, format } = await ensureCompatibleFormat(audioBuffer);

    const [userText, { transcript: assistantText, audioResponse }] = await Promise.all([
      speechToText(buffer, format, language),
      voiceChat(buffer, selectedVoice, format, "mp3"),
    ]);

    res.json({
      audio: audioResponse.toString("base64"),
      userText,
      assistantText,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice processing failed";
    req.log?.error({ err }, "Voice chat error");
    res.status(500).json({ error: message });
  }
});

export default router;
