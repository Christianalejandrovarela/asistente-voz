/**
 * voiceLoopService.ts
 *
 * The ENTIRE voice-session loop (Record → API → TTS → repeat) lives here as
 * MODULE-LEVEL state.  Module-level variables persist for the lifetime of the
 * React Native JS runtime, regardless of React component mounts/unmounts.
 * This means the loop keeps running even when the UI is suspended (screen off).
 *
 * React components (AssistantContext) subscribe to DeviceEventEmitter events
 * emitted here and mirror the state to React state for display purposes only.
 * The authoritative state is always this module.
 *
 * PlaybackService (headless) can call toggleVoiceLoop() directly — no
 * DeviceEventEmitter round-trip needed, same JS runtime, same module state.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { DeviceEventEmitter, Platform } from "react-native";

import {
  addMessage,
  clearMessages,
  getMessages,
  purgeOldMessages,
} from "@/services/conversationDb";
import { pauseSilentTrack, resumeSilentTrack } from "@/services/trackPlayer";
import { RollingBufferManager } from "@/services/rollingBufferManager";

// ─── Public types ─────────────────────────────────────────────────────────────

export type VoiceLoopStatus =
  | "idle"
  | "waiting"
  | "recording"
  | "processing"
  | "speaking";

export interface VoiceMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

// ─── DeviceEventEmitter event keys ───────────────────────────────────────────
// AssistantContext subscribes to these to update React state for UI display.

export const VL_STATUS  = "VL_STATUS";   // payload: { status: VoiceLoopStatus }
export const VL_SESSION = "VL_SESSION";  // payload: { active: boolean }
export const VL_MESSAGES = "VL_MESSAGES"; // payload: { messages: VoiceMessage[] }
export const VL_DEBUG   = "VL_DEBUG";    // payload: { info: string }
export const VL_ERROR   = "VL_ERROR";    // payload: { title: string; body: string }

// ─── Constants ────────────────────────────────────────────────────────────────

const VAD_SILENCE_THRESHOLD_DB = -45;
const VAD_SILENCE_DURATION_MS  = 1500;
const VAD_MIN_SPEECH_MS        = 300;
const MAX_RECORDING_MS         = 60_000;
const FOLLOW_UP_WINDOW_MS      = 7_000;
const MAX_MIC_RETRIES          = 3;

const SETTINGS_KEY        = "@voice_assistant_settings";
const CONTEXT_SUMMARY_KEY = "@context_summary";

// ─── Module-level state ───────────────────────────────────────────────────────

let _isActive       = false;
let _status: VoiceLoopStatus = "idle";
let _recording:    Audio.Recording | null = null;
let _bargeInRec:   Audio.Recording | null = null;
let _sound:        Audio.Sound | null = null;
let _abortCtrl:    AbortController | null = null;
let _maxTimer:     ReturnType<typeof setTimeout> | null = null;
let _followUpTimer: ReturnType<typeof setTimeout> | null = null;
let _micRetryCount = 0;
let _playbackResolve: (() => void) | null = null;
let _contextSummary = "";

// ─── Internal helpers ─────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

function setStatusSync(s: VoiceLoopStatus): void {
  _status = s;
  DeviceEventEmitter.emit(VL_STATUS, { status: s });
}

function clearMaxTimer(): void {
  if (_maxTimer !== null) { clearTimeout(_maxTimer); _maxTimer = null; }
}
function clearFollowUpTimer(): void {
  if (_followUpTimer !== null) { clearTimeout(_followUpTimer); _followUpTimer = null; }
}

function emitDebug(info: string): void {
  console.log("[VoiceLoop]", info);
  DeviceEventEmitter.emit(VL_DEBUG, { info });
}

function emitError(title: string, body: string): void {
  console.error("[VoiceLoop] ERROR:", title, body);
  DeviceEventEmitter.emit(VL_ERROR, { title, body });
}

async function getSettings(): Promise<{ voice: string; language: string }> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw) as { voice: string; language: string };
  } catch {}
  return { voice: "nova", language: "es" };
}

/**
 * FIX 1 — Robust Recording Cleanup.
 *
 * Before EVERY Audio.Recording.createAsync() call we force-stop and unload
 * ALL existing recording objects.  Prevents the fatal:
 *   "Only one Recording object can be prepared at a given time"
 * which occurs when the barge-in or main recording is not cleaned up between
 * turns (e.g. stopAndUnloadAsync() threw and was silently swallowed).
 */
async function forceCleanupAllRecordings(): Promise<void> {
  if (_recording !== null) {
    emitDebug("Force-cleaning orphaned main recording");
    const r = _recording;
    _recording = null;
    try { r.setOnRecordingStatusUpdate(null); await r.stopAndUnloadAsync(); } catch {}
  }
  if (_bargeInRec !== null) {
    emitDebug("Force-cleaning orphaned barge-in recording");
    const r = _bargeInRec;
    _bargeInRec = null;
    try { r.setOnRecordingStatusUpdate(null); await r.stopAndUnloadAsync(); } catch {}
  }
}

async function readUriAsBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: "base64" });
}

// ─── Audio playback ───────────────────────────────────────────────────────────

async function playResponseAudio(base64Audio: string): Promise<void> {
  // Clean up any leftover sound from a previous turn
  if (_sound !== null) {
    try { await _sound.stopAsync();   } catch {}
    try { await _sound.unloadAsync(); } catch {}
    _sound = null;
  }

  // Always configure audio mode before playback
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
    ...(Platform.OS === "android" ? {
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    } : {}),
  });

  const tmpPath = `${FileSystem.cacheDirectory ?? ""}ai_resp_${Date.now()}.mp3`;
  try {
    await FileSystem.writeAsStringAsync(tmpPath, base64Audio, { encoding: "base64" });

    let resolvePlayback!: () => void;
    const playbackDone = new Promise<void>((res) => {
      resolvePlayback = res;
      _playbackResolve = res;
    });

    const { sound } = await Audio.Sound.createAsync(
      { uri: tmpPath },
      { shouldPlay: true, volume: 1.0 },
      (ps) => {
        if (!ps.isLoaded) return;
        if (
          ps.didJustFinish ||
          (!ps.isPlaying &&
            ps.positionMillis > 0 &&
            ps.durationMillis !== undefined &&
            ps.positionMillis >= ps.durationMillis - 200)
        ) {
          resolvePlayback();
        }
      }
    );
    _sound = sound;

    // ── Barge-in: open mic monitor while AI speaks ─────────────────────────
    // Use try/finally to GUARANTEE cleanup even if the inner code throws.
    try {
      // Force-cleanup any stale recordings before opening barge-in mic
      await forceCleanupAllRecordings();

      const { recording } = await Audio.Recording.createAsync(
        { ...Audio.RecordingOptionsPresets.HIGH_QUALITY, isMeteringEnabled: true },
        undefined,
        80
      );
      _bargeInRec = recording;
      let speechStart: number | null = null;

      recording.setOnRecordingStatusUpdate((s) => {
        if (!s.isRecording || !_isActive) return;
        const db = s.metering ?? -160;
        if (db > VAD_SILENCE_THRESHOLD_DB) {
          if (!speechStart) speechStart = Date.now();
          if (Date.now() - speechStart >= VAD_MIN_SPEECH_MS) {
            recording.setOnRecordingStatusUpdate(null);
            resolvePlayback(); // barge-in: interrupt AI speech
          }
        } else {
          speechStart = null;
        }
      });
    } catch {
      // Barge-in unavailable — continue without it
    }

    // Safety-net: unblock after 3 min if status callback never fires
    const safetyTimeout = new Promise<void>((res) => setTimeout(res, 3 * 60 * 1000));
    await Promise.race([playbackDone, safetyTimeout]);

    // ── Always clean up barge-in and sound ────────────────────────────────
    if (_bargeInRec !== null) {
      const r = _bargeInRec;
      _bargeInRec = null;
      try { r.setOnRecordingStatusUpdate(null); await r.stopAndUnloadAsync(); } catch {}
    }
    _playbackResolve = null;
    try { await sound.stopAsync();   } catch {}
    try { await sound.unloadAsync(); } catch {}
    _sound = null;
  } finally {
    try { await FileSystem.deleteAsync(tmpPath, { idempotent: true }); } catch {}
  }
}

// ─── Recording loop ───────────────────────────────────────────────────────────

async function startListening(isFollowUp = false): Promise<void> {
  if (!_isActive) return;
  if (_status !== "idle") return;

  try {
    const { status: permStatus } = await Audio.requestPermissionsAsync();
    if (permStatus !== "granted") {
      emitError(
        "Permiso de micrófono",
        "Para usar el asistente necesitas conceder acceso al micrófono en los ajustes."
      );
      await stopVoiceLoop();
      return;
    }

    clearFollowUpTimer();
    await RollingBufferManager.pause();
    await pauseSilentTrack();

    // FIX 1: Always force-cleanup ALL recording objects before createAsync.
    // This prevents "Only one Recording object can be prepared at a given time".
    await forceCleanupAllRecordings();

    // Steal exclusive audio focus from RNTP synchronously.
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      ...(Platform.OS === "android" ? {
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      } : {}),
    });

    const { recording } = await Audio.Recording.createAsync(
      { ...Audio.RecordingOptionsPresets.HIGH_QUALITY, isMeteringEnabled: true },
      undefined,
      100
    );

    _recording = recording;
    _micRetryCount = 0;
    setStatusSync(isFollowUp ? "waiting" : "recording");

    let hasSpeech        = false;
    let silenceStart: number | null = null;
    let speechStartTime: number | null = null;
    let vadTriggered     = false;

    if (isFollowUp) {
      _followUpTimer = setTimeout(() => {
        if (!hasSpeech && !vadTriggered && _isActive) {
          emitDebug("Follow-up window expired — ending session");
          recording.setOnRecordingStatusUpdate(null);
          clearMaxTimer();
          void stopVoiceLoop();
        }
      }, FOLLOW_UP_WINDOW_MS);
    }

    recording.setOnRecordingStatusUpdate((s) => {
      if (!_isActive || vadTriggered) return;
      if (!s.isRecording) return;

      const metering = s.metering ?? -160;
      const now = Date.now();

      if (metering > VAD_SILENCE_THRESHOLD_DB) {
        if (!hasSpeech) {
          hasSpeech = true;
          speechStartTime = now;
          clearFollowUpTimer();
          if (_status === "waiting") setStatusSync("recording");
        }
        silenceStart = null;
      } else if (hasSpeech) {
        if (!silenceStart) silenceStart = now;
        const speechDuration = speechStartTime ? now - speechStartTime : 0;
        if (
          now - silenceStart >= VAD_SILENCE_DURATION_MS &&
          speechDuration >= VAD_MIN_SPEECH_MS
        ) {
          vadTriggered = true;
          recording.setOnRecordingStatusUpdate(null);
          clearMaxTimer();
          clearFollowUpTimer();
          void sendCurrentRecording();
        }
      }
    });

    _maxTimer = setTimeout(() => {
      if (!vadTriggered && _isActive &&
        (_status === "recording" || _status === "waiting")) {
        vadTriggered = true;
        clearFollowUpTimer();
        void sendCurrentRecording();
      }
    }, MAX_RECORDING_MS);

  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    _micRetryCount += 1;
    emitDebug(`Error mic (${_micRetryCount}/${MAX_MIC_RETRIES}): ${msg}`);
    setStatusSync("idle");
    await RollingBufferManager.resume();
    await resumeSilentTrack();

    if (_isActive) {
      if (_micRetryCount < MAX_MIC_RETRIES) {
        setTimeout(() => { void startListening(); }, 1000 * _micRetryCount);
      } else {
        console.error("[VoiceLoop] Max mic retries reached — stopping session");
        emitError(
          "Error de micrófono",
          `No se pudo iniciar el micrófono después de ${MAX_MIC_RETRIES} intentos.\n\n${msg}`
        );
        void stopVoiceLoop();
      }
    }
  }
}

async function sendCurrentRecording(): Promise<void> {
  clearMaxTimer();
  if ((_status !== "recording" && _status !== "waiting") || _recording === null) return;
  setStatusSync("processing");

  // FIX 1: Use try/finally to guarantee recording cleanup on every path.
  const recording = _recording;
  _recording = null;

  try {
    await recording.stopAndUnloadAsync();
  } catch {
    // Even if stopAndUnload throws, the recording object is released at this
    // point — proceed with whatever URI was captured
  }

  const uri = recording.getURI();

  try {
    if (!uri) throw new Error("No recording URI");

    const base64Audio = await readUriAsBase64(uri);

    if (!_isActive) {
      setStatusSync("idle");
      await RollingBufferManager.resume();
      await resumeSilentTrack();
      return;
    }

    const domain = process.env.EXPO_PUBLIC_DOMAIN;
    const apiUrl = domain
      ? `https://${domain}/api/voice/chat`
      : "http://localhost:8080/api/voice/chat";

    await purgeOldMessages();
    const settings = await getSettings();
    const recentHistory = await getMessages(20);
    const contextText = RollingBufferManager.getContextText();

    const historyPayload: { role: string; text: string }[] = [];
    if (contextText.length > 0) {
      historyPayload.push({ role: "user", text: `[Contexto ambiental]: ${contextText}` });
    }
    for (const m of recentHistory) {
      if (!m.text.startsWith("[contexto]")) {
        historyPayload.push({ role: m.role, text: m.text });
      }
    }

    _abortCtrl = new AbortController();
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio: base64Audio,
        voice: settings.voice,
        language: settings.language,
        history: historyPayload.slice(-30),
        contextSummary: _contextSummary || undefined,
      }),
      signal: _abortCtrl.signal,
    });
    _abortCtrl = null;

    if (!_isActive) {
      setStatusSync("idle");
      await RollingBufferManager.resume();
      await resumeSilentTrack();
      return;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API ${response.status}: ${errText}`);
    }

    interface ApiResponse {
      audio: string;
      userText: string;
      assistantText: string;
      newContextSummary?: string;
    }
    const data = await response.json() as ApiResponse;
    const now = Date.now();

    if (data.newContextSummary) {
      emitDebug("Context compressed — resetting local history");
      _contextSummary = data.newContextSummary;
      await clearMessages();
      void AsyncStorage.setItem(CONTEXT_SUMMARY_KEY, data.newContextSummary);
      DeviceEventEmitter.emit(VL_MESSAGES, { messages: [] });
    }

    const userMsg:  VoiceMessage = { id: generateId(), role: "user",      text: data.userText,      timestamp: now };
    const assistMsg: VoiceMessage = { id: generateId(), role: "assistant", text: data.assistantText, timestamp: now + 1 };
    void addMessage(userMsg);
    void addMessage(assistMsg);
    DeviceEventEmitter.emit(VL_MESSAGES, { append: [userMsg, assistMsg] });

    if (!_isActive) {
      setStatusSync("idle");
      await RollingBufferManager.resume();
      await resumeSilentTrack();
      return;
    }

    setStatusSync("speaking");
    await playResponseAudio(data.audio);

    if (_isActive) {
      setStatusSync("idle");
      // Gemini Live-style: mic reopens automatically after AI responds
      void startListening(true);
    } else {
      setStatusSync("idle");
      await RollingBufferManager.resume();
      await resumeSilentTrack();
    }

  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (!isAbort) {
      const message = err instanceof Error ? err.message : "Error desconocido";
      emitError("Error", `No se pudo procesar: ${message}`);
    }
    setStatusSync("idle");
    await RollingBufferManager.resume();
    await resumeSilentTrack();
    if (_isActive && !isAbort) {
      setTimeout(() => { void startListening(); }, 1000);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Start a new voice session (record → API → TTS → loop). */
export async function startVoiceLoop(): Promise<void> {
  if (_isActive) return;
  _isActive = true;
  _micRetryCount = 0;

  // Load context summary from storage (may have been set in a previous session)
  try {
    const stored = await AsyncStorage.getItem(CONTEXT_SUMMARY_KEY);
    if (stored) _contextSummary = stored;
  } catch {}

  DeviceEventEmitter.emit(VL_SESSION, { active: true });
  emitDebug("Sesión iniciada");
  await startListening();
}

/** Stop the current voice session and clean up all resources. */
export async function stopVoiceLoop(): Promise<void> {
  if (!_isActive) return;
  _isActive = false;
  DeviceEventEmitter.emit(VL_SESSION, { active: false });

  clearMaxTimer();
  clearFollowUpTimer();

  if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }

  // Interrupt playback if speaking
  if (_playbackResolve) { _playbackResolve(); _playbackResolve = null; }

  // Force-cleanup all recordings
  await forceCleanupAllRecordings();

  // Stop sound
  if (_sound !== null) {
    try { await _sound.stopAsync();   } catch {}
    try { await _sound.unloadAsync(); } catch {}
    _sound = null;
  }

  await RollingBufferManager.resume();
  await resumeSilentTrack();
  setStatusSync("idle");
  emitDebug("Sesión terminada");
}

/** Toggle between start and stop. Called by PlaybackService and the UI. */
export function toggleVoiceLoop(): void {
  if (_isActive) {
    void stopVoiceLoop();
  } else {
    void startVoiceLoop();
  }
}

/** Interrupt TTS playback and immediately start listening again. */
export function interruptSpeaking(): void {
  if (_status !== "speaking") return;
  if (_playbackResolve) { _playbackResolve(); _playbackResolve = null; }
}

/** Read-only snapshot of current state (for AssistantContext sync on mount). */
export function getVoiceLoopSnapshot(): { status: VoiceLoopStatus; isActive: boolean } {
  return { status: _status, isActive: _isActive };
}

/** Called by AssistantContext when the user changes settings (voice/language). */
export function updateLoopSettings(settings: { voice: string; language: string }): void {
  void AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
