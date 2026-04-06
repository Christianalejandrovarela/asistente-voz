export { registerAudioRoutes } from "./routes";
export {
  openai,
  detectAudioFormat,
  convertToWav,
  ensureCompatibleFormat,
  type AudioFormat,
  type ConversationHistoryEntry,
  voiceChat,
  voiceChatStream,
  compressContext,
  textToSpeech,
  textToSpeechStream,
  speechToText,
  speechToTextStream,
} from "./client";
