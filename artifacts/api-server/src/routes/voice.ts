import { Router, type Request, type Response } from "express";
import {
  voiceChat,
  speechToText,
  ensureCompatibleFormat,
} from "@workspace/integrations-openai-ai-server/audio";

const router = Router();

type VoiceParam = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
const VALID_VOICES: VoiceParam[] = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

router.post("/voice/chat", async (req: Request, res: Response) => {
  const { audio, voice = "nova", language } = req.body as {
    audio?: string;
    voice?: string;
    language?: string;
  };

  if (!audio || typeof audio !== "string") {
    res.status(400).json({ error: "audio field is required and must be a base64 string" });
    return;
  }

  const selectedVoice: VoiceParam = VALID_VOICES.includes(voice as VoiceParam)
    ? (voice as VoiceParam)
    : "nova";

  let audioBuffer: Buffer;
  try {
    audioBuffer = Buffer.from(audio, "base64");
  } catch {
    res.status(400).json({ error: "Invalid base64 audio data" });
    return;
  }

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
    req.log?.error({ err }, "Voice chat processing error");
    res.status(500).json({ error: message });
  }
});

export default router;
