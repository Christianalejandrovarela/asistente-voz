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
import { rlog, rwarn, rerror } from "@/services/remoteLogger";

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
let _sound:        Audio.Sound | null = null;
let _abortCtrl:    AbortController | null = null;
let _maxTimer:     ReturnType<typeof setTimeout> | null = null;
let _followUpTimer: ReturnType<typeof setTimeout> | null = null;
let _micRetryCount = 0;
let _playbackResolve: (() => void) | null = null;
let _contextSummary = "";

/**
 * MUTEX — Hardware microphone lock.
 *
 * Set to true synchronously (no await in between check and set) at the very
 * beginning of startListening() BEFORE any async operation that touches the
 * recording hardware.  Cleared only when:
 *   1. startListening() catches an error (mic failed to open)
 *   2. sendCurrentRecording() finishes stopAndUnloadAsync() (hardware freed)
 *   3. stopVoiceLoop() is called (emergency reset)
 *
 * Prevents the "Only one Recording object can be prepared at a given time"
 * error that arises when the Bluetooth button fires multiple events in rapid
 * succession or a retry races with an in-progress setup.
 */
let _isMicrophoneBusy = false;

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
 * Robust Recording Cleanup.
 *
 * Stops and unloads the main recording AND any recording the RollingBuffer
 * Manager may have started after pause() returned (race condition where a
 * segment timer fires in the pause gap).  Called before EVERY createAsync().
 */
async function forceCleanupAllRecordings(): Promise<void> {
  if (_recording !== null) {
    emitDebug("Force-cleaning orphaned main recording");
    const r = _recording;
    _recording = null;
    try { r.setOnRecordingStatusUpdate(null); await r.stopAndUnloadAsync(); } catch {}
  }
  // Also stop any recording the RollingBufferManager may have started between
  // the pause() call returning and createAsync() being invoked.
  try { await RollingBufferManager.forceStopRecording(); } catch {}
}

async function readUriAsBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: "base64" });
}

// ─── Audio playback (strict sequential — no barge-in) ─────────────────────────
//
// expo-av is unstable when an Audio.Recording object is active while an
// Audio.Sound is playing on the same hardware.  The barge-in feature has
// been removed.  The flow is now strictly:
//   Record → stop/unload → API → TTS play → stop/unload → Record …

async function playResponseAudio(base64Audio: string): Promise<void> {
  // Clean up any leftover sound from a previous turn
  if (_sound !== null) {
    try { await _sound.stopAsync();   } catch {}
    try { await _sound.unloadAsync(); } catch {}
    _sound = null;
  }

  // Configure audio mode for playback
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

    // Safety-net: unblock after 3 min if status callback never fires
    const safetyTimeout = new Promise<void>((res) => setTimeout(res, 3 * 60 * 1000));
    await Promise.race([playbackDone, safetyTimeout]);

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

  // MUTEX: Prevent concurrent microphone-setup attempts.
  // In JS there are no thread pre-emptions, so this check+set is atomic.
  if (_isMicrophoneBusy) {
    rwarn("MUTEX", `BLOCKED — _isMicrophoneBusy=true, rejecting concurrent startListening (status=${_status})`);
    emitDebug("Mic busy — ignoring concurrent startListening call");
    return;
  }
  _isMicrophoneBusy = true;  // Lock the hardware mic
  rlog("MUTEX", `ACQUIRED — _isMicrophoneBusy=true (isFollowUp=${isFollowUp})`);

  try {
    const { status: permStatus } = await Audio.requestPermissionsAsync();
    rlog("MIC", `requestPermissionsAsync → ${permStatus}`);
    if (permStatus !== "granted") {
      rerror("MIC", "Permission NOT granted — stopping session");
      emitError(
        "Permiso de micrófono",
        "Para usar el asistente necesitas conceder acceso al micrófono en los ajustes."
      );
      _isMicrophoneBusy = false;
      await stopVoiceLoop();
      return;
    }

    clearFollowUpTimer();
    await RollingBufferManager.pause();
    await pauseSilentTrack();

    // Guarantee all recording objects are released before createAsync.
    rlog("MIC", "forceCleanupAllRecordings() start");
    await forceCleanupAllRecordings();
    rlog("MIC", "forceCleanupAllRecordings() done — about to createAsync()");

    // Claim exclusive audio focus for recording.
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      ...(Platform.OS === "android" ? {
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      } : {}),
    });

    rlog("MIC", "Audio.Recording.createAsync() → opening hardware mic...");
    const { recording } = await Audio.Recording.createAsync(
      { ...Audio.RecordingOptionsPresets.HIGH_QUALITY, isMeteringEnabled: true },
      undefined,
      100
    );
    rlog("MIC", "Audio.Recording.createAsync() ✓ — hardware mic is open");

    // Recording is live — mutex stays locked until sendCurrentRecording releases it.
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
    // Release mutex so retries can proceed
    _isMicrophoneBusy = false;
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    rerror("MIC", `createAsync FAILED (retry ${_micRetryCount + 1}/${MAX_MIC_RETRIES}): ${msg}`);
    rlog("MUTEX", `RELEASED — error path (retry ${_micRetryCount + 1})`);
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

  const recording = _recording;
  _recording = null;

  rlog("MIC", "stopAndUnloadAsync() — releasing hardware mic...");
  try {
    await recording.stopAndUnloadAsync();
    rlog("MIC", "stopAndUnloadAsync() ✓ — hardware mic released");
  } catch (e) {
    rwarn("MIC", `stopAndUnloadAsync() threw (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }

  // Hardware mic is now free — release the mutex before any await operations
  // so the next startListening() call can proceed after TTS playback finishes.
  _isMicrophoneBusy = false;
  rlog("MUTEX", "RELEASED — mic hardware free, loop continues to API+TTS");

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

    rlog("API", `fetch → ${apiUrl}`);
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

    rlog("API", `response OK — userText="${data.userText.slice(0,60)}" assistText="${data.assistantText.slice(0,60)}"`);
    setStatusSync("speaking");
    rlog("TTS", "playResponseAudio() start");
    await playResponseAudio(data.audio);
    rlog("TTS", "playResponseAudio() done");

    if (_isActive) {
      setStatusSync("idle");
      rlog("LOOP", "TTS done, _isActive=true → startListening(followUp)");
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
  rlog("LOOP", "startVoiceLoop() — _isActive=false → starting session");
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
  rlog("LOOP", `stopVoiceLoop() — status=${_status} micBusy=${_isMicrophoneBusy}`);
  _isActive = false;
  _isMicrophoneBusy = false;  // Emergency reset of the hardware lock
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
