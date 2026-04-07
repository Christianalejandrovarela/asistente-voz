/**
 * voiceLoopService.ts  — Diagnostic build
 *
 * ARCHITECTURE
 * ────────────
 * All voice-loop state lives at MODULE level (not in React refs) so the loop
 * persists through React component unmounts and runs headlessly when the
 * screen is off.  PlaybackService calls toggleVoiceLoop() directly — same JS
 * runtime, same module state.
 *
 * DIAGNOSTIC LOGGING
 * ──────────────────
 * Every critical hardware event is logged via rlog/rwarn/rerror to the
 * Replit API server in real-time over HTTP (fire-and-forget).  This gives
 * visibility into what happens on the physical device when the screen is off.
 * Watch: artifacts/api-server workflow console for  📱 [APP ANDROID] lines.
 *
 * INTENTIONAL SIMPLICITY
 * ──────────────────────
 * Patches (mutex, rolling-buffer force-stop, complex cleanup cascades) have
 * been removed.  The goal of this build is DIAGNOSIS, not fixing.  The logs
 * will tell us the exact failure point so we can apply a targeted fix.
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

// ─── DeviceEventEmitter keys (subscribed by AssistantContext) ─────────────────

export const VL_STATUS   = "VL_STATUS";
export const VL_SESSION  = "VL_SESSION";
export const VL_MESSAGES = "VL_MESSAGES";
export const VL_DEBUG    = "VL_DEBUG";
export const VL_ERROR    = "VL_ERROR";

// ─── Constants ────────────────────────────────────────────────────────────────

const VAD_SILENCE_DB      = -45;
const VAD_SILENCE_MS      = 1500;
const VAD_MIN_SPEECH_MS   = 300;
const MAX_RECORDING_MS    = 60_000;
const FOLLOW_UP_MS        = 7_000;
const MAX_MIC_RETRIES     = 3;
const SETTINGS_KEY        = "@voice_assistant_settings";
const CONTEXT_SUMMARY_KEY = "@context_summary";

// ─── Module-level state ───────────────────────────────────────────────────────
// These variables persist for the lifetime of the JS runtime.

let _isActive    = false;
let _status: VoiceLoopStatus = "idle";
// Cache permission result: requestPermissionsAsync() can take 10-16 seconds
// when the screen is off on Samsung One UI — we avoid the delay by caching
// the result after first grant and using getPermissionsAsync() on retries.
let _micPermissionGranted = false;
// Mutex flag: prevents two concurrent startListening() calls from racing.
let _startListeningInFlight = false;
let _recording:  Audio.Recording | null = null;
let _sound:      Audio.Sound | null = null;
let _abortCtrl:  AbortController | null = null;
let _maxTimer:   ReturnType<typeof setTimeout> | null = null;
let _followUpTimer: ReturnType<typeof setTimeout> | null = null;
let _micRetryCount = 0;
let _playbackResolve: (() => void) | null = null;
let _contextSummary = "";

// ─── Internal helpers ─────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function setStatus(s: VoiceLoopStatus): void {
  _status = s;
  DeviceEventEmitter.emit(VL_STATUS, { status: s });
}

function clearMaxTimer(): void {
  if (_maxTimer) { clearTimeout(_maxTimer); _maxTimer = null; }
}
function clearFollowUpTimer(): void {
  if (_followUpTimer) { clearTimeout(_followUpTimer); _followUpTimer = null; }
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
 * Stop and unload the current recording object if one exists.
 * Simple, single-purpose — no cascade, no rolling-buffer involvement.
 */
async function stopCurrentRecording(): Promise<void> {
  if (_recording === null) {
    rlog("MIC", "stopCurrentRecording() — _recording already null, nothing to stop");
    return;
  }
  rlog("MIC", "stopCurrentRecording() — calling stopAndUnloadAsync()...");
  const r = _recording;
  _recording = null;
  try {
    r.setOnRecordingStatusUpdate(null);
    await r.stopAndUnloadAsync();
    rlog("MIC", "stopCurrentRecording() ✓");
  } catch (e) {
    rwarn("MIC", `stopCurrentRecording() threw (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function readUriAsBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: "base64" });
}

// ─── Audio playback (sequential — no concurrent recording) ────────────────────

async function playResponseAudio(base64Audio: string): Promise<void> {
  if (_sound !== null) {
    rlog("TTS", "playResponseAudio() — cleaning up previous sound");
    try { await _sound.stopAsync();   } catch {}
    try { await _sound.unloadAsync(); } catch {}
    _sound = null;
  }

  rlog("TTS", "playResponseAudio() — setAudioModeAsync for playback");
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
    rlog("TTS", "playResponseAudio() — Audio.Sound.createAsync start");

    let resolvePlayback!: () => void;
    const done = new Promise<void>((res) => {
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
    rlog("TTS", "playResponseAudio() — sound playing, waiting for finish...");

    const safety = new Promise<void>((res) => setTimeout(res, 3 * 60_000));
    await Promise.race([done, safety]);

    _playbackResolve = null;
    try { await sound.stopAsync();   } catch {}
    try { await sound.unloadAsync(); } catch {}
    _sound = null;
    rlog("TTS", "playResponseAudio() ✓ done");
  } finally {
    try { await FileSystem.deleteAsync(tmpPath, { idempotent: true }); } catch {}
  }
}

// ─── Recording loop ───────────────────────────────────────────────────────────

async function startListening(isFollowUp = false): Promise<void> {
  rlog("MIC", `startListening(followUp=${isFollowUp}) — _isActive=${_isActive} _status=${_status}`);

  if (!_isActive) { rlog("MIC", "startListening() early-exit: _isActive=false"); return; }
  if (_status !== "idle") { rlog("MIC", `startListening() early-exit: status=${_status} (expected idle)`); return; }
  if (_startListeningInFlight) { rlog("MIC", "startListening() early-exit: already in-flight (mutex)"); return; }
  _startListeningInFlight = true;

  try {
    if (!_micPermissionGranted) {
      // First-time check: call requestPermissionsAsync() to trigger the system dialog.
      rlog("MIC", "requestPermissionsAsync() — asking for mic permission...");
      const { status: perm } = await Audio.requestPermissionsAsync();
      rlog("MIC", `requestPermissionsAsync() → ${perm}`);
      if (perm !== "granted") {
        rerror("MIC", "PERMISSION DENIED — cannot record");
        emitError("Permiso de micrófono", "Activa el micrófono en los ajustes.");
        await stopVoiceLoop();
        return;
      }
      _micPermissionGranted = true;
    } else {
      // Fast path: use getPermissionsAsync() (returns instantly, no system dialog delay).
      // On Samsung with screen off, requestPermissionsAsync() blocks for 10-16 seconds
      // even when the permission is already granted — this avoids that stall.
      const { status: perm } = await Audio.getPermissionsAsync();
      rlog("MIC", `getPermissionsAsync() (cached path) → ${perm}`);
      if (perm !== "granted") {
        _micPermissionGranted = false;
        rerror("MIC", "PERMISSION REVOKED — cannot record");
        emitError("Permiso de micrófono", "El permiso fue revocado. Activa el micrófono en los ajustes.");
        await stopVoiceLoop();
        return;
      }
    }

    clearFollowUpTimer();

    rlog("MIC", "RollingBufferManager.pause() + pauseSilentTrack()");
    await RollingBufferManager.pause();
    await pauseSilentTrack();

    // Stop previous recording if somehow still active (diagnostic: log if it happens)
    if (_recording !== null) {
      rwarn("MIC", "UNEXPECTED: _recording is not null at startListening start — stopping it");
    }
    await stopCurrentRecording();

    rlog("MIC", "setAudioModeAsync for recording...");
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      ...(Platform.OS === "android" ? {
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      } : {}),
    });
    rlog("MIC", "setAudioModeAsync ✓");

    rlog("MIC", "Audio.Recording.createAsync() — opening hardware mic...");
    const { recording } = await Audio.Recording.createAsync(
      { ...Audio.RecordingOptionsPresets.HIGH_QUALITY, isMeteringEnabled: true },
      undefined,
      100
    );
    rlog("MIC", "Audio.Recording.createAsync() ✓ — hardware mic is OPEN");

    _recording = recording;
    _micRetryCount = 0;
    setStatus(isFollowUp ? "waiting" : "recording");
    _startListeningInFlight = false; // mutex released — recording is live

    let hasSpeech       = false;
    let silenceStart: number | null = null;
    let speechStart: number | null = null;
    let vadTriggered    = false;

    if (isFollowUp) {
      _followUpTimer = setTimeout(() => {
        if (!hasSpeech && !vadTriggered && _isActive) {
          rlog("VAD", "follow-up window expired — no speech detected, stopping session");
          recording.setOnRecordingStatusUpdate(null);
          clearMaxTimer();
          void stopVoiceLoop();
        }
      }, FOLLOW_UP_MS);
    }

    recording.setOnRecordingStatusUpdate((s) => {
      if (!_isActive || vadTriggered) return;
      if (!s.isRecording) return;

      const db  = s.metering ?? -160;
      const now = Date.now();

      if (db > VAD_SILENCE_DB) {
        if (!hasSpeech) {
          hasSpeech  = true;
          speechStart = now;
          clearFollowUpTimer();
          if (_status === "waiting") setStatus("recording");
        }
        silenceStart = null;
      } else if (hasSpeech) {
        if (!silenceStart) silenceStart = now;
        const dur = speechStart ? now - speechStart : 0;
        if (now - silenceStart >= VAD_SILENCE_MS && dur >= VAD_MIN_SPEECH_MS) {
          vadTriggered = true;
          recording.setOnRecordingStatusUpdate(null);
          clearMaxTimer();
          clearFollowUpTimer();
          rlog("VAD", `VAD triggered — speechDuration=${dur}ms silence=${now - silenceStart}ms`);
          void sendCurrentRecording();
        }
      }
    });

    _maxTimer = setTimeout(() => {
      if (!vadTriggered && _isActive && (_status === "recording" || _status === "waiting")) {
        rlog("VAD", "MAX recording time reached — sending anyway");
        vadTriggered = true;
        clearFollowUpTimer();
        void sendCurrentRecording();
      }
    }, MAX_RECORDING_MS);

  } catch (err) {
    _startListeningInFlight = false; // mutex released on error path
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    _micRetryCount += 1;
    rerror("MIC", `startListening CATCH — attempt ${_micRetryCount}/${MAX_MIC_RETRIES}: ${msg}`);
    emitDebug(`Error mic (${_micRetryCount}/${MAX_MIC_RETRIES}): ${msg}`);
    setStatus("idle");
    await RollingBufferManager.resume();
    await resumeSilentTrack();

    if (_isActive) {
      if (_micRetryCount < MAX_MIC_RETRIES) {
        const delay = 1000 * _micRetryCount;
        rlog("MIC", `scheduling retry in ${delay}ms`);
        setTimeout(() => { void startListening(); }, delay);
      } else {
        rerror("MIC", `MAX RETRIES REACHED — giving up, stopping session`);
        emitError("Error de micrófono", `No se pudo iniciar el micrófono (${MAX_MIC_RETRIES} intentos).\n\n${msg}`);
        void stopVoiceLoop();
      }
    }
  }
}

async function sendCurrentRecording(): Promise<void> {
  rlog("MIC", `sendCurrentRecording() — status=${_status} _recording=${_recording !== null}`);
  clearMaxTimer();
  if ((_status !== "recording" && _status !== "waiting") || _recording === null) {
    rwarn("MIC", "sendCurrentRecording() early-exit: wrong status or null recording");
    return;
  }
  setStatus("processing");

  // Snapshot and null out before await so no other path can grab this reference
  const recording = _recording;
  _recording = null;

  rlog("MIC", "sendCurrentRecording() — stopAndUnloadAsync()...");
  try {
    await recording.stopAndUnloadAsync();
    rlog("MIC", "sendCurrentRecording() — stopAndUnloadAsync() ✓ hardware mic released");
  } catch (e) {
    rwarn("MIC", `sendCurrentRecording() — stopAndUnloadAsync() threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  const uri = recording.getURI();
  rlog("MIC", `sendCurrentRecording() — URI=${uri ?? "null"}`);

  try {
    if (!uri) throw new Error("No recording URI after stopAndUnload");

    const base64Audio = await readUriAsBase64(uri);
    rlog("API", `audio captured — ${(base64Audio.length * 0.75 / 1024).toFixed(0)} KB, sending to API...`);

    if (!_isActive) {
      rlog("API", "sendCurrentRecording() aborted — _isActive=false before fetch");
      setStatus("idle");
      await RollingBufferManager.resume();
      await resumeSilentTrack();
      return;
    }

    const domain = process.env.EXPO_PUBLIC_DOMAIN;
    const apiUrl = domain
      ? `https://${domain}/api/voice/chat`
      : "http://localhost:8080/api/voice/chat";

    await purgeOldMessages();
    const settings     = await getSettings();
    const history      = await getMessages(20);
    const contextText  = RollingBufferManager.getContextText();

    const payload: { role: string; text: string }[] = [];
    if (contextText) payload.push({ role: "user", text: `[Contexto]: ${contextText}` });
    for (const m of history) {
      if (!m.text.startsWith("[contexto]")) payload.push({ role: m.role, text: m.text });
    }

    rlog("API", `fetch POST ${apiUrl}`);
    _abortCtrl = new AbortController();
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio: base64Audio,
        voice: settings.voice,
        language: settings.language,
        history: payload.slice(-30),
        contextSummary: _contextSummary || undefined,
      }),
      signal: _abortCtrl.signal,
    });
    _abortCtrl = null;

    if (!_isActive) {
      rlog("API", "response received but _isActive=false — discarding");
      setStatus("idle");
      await RollingBufferManager.resume();
      await resumeSilentTrack();
      return;
    }

    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`API ${response.status}: ${txt}`);
    }

    interface ApiResp {
      audio: string;
      userText: string;
      assistantText: string;
      newContextSummary?: string;
    }
    const data = await response.json() as ApiResp;
    rlog("API", `response OK — user="${data.userText.slice(0,50)}" asst="${data.assistantText.slice(0,50)}"`);

    const now = Date.now();
    if (data.newContextSummary) {
      _contextSummary = data.newContextSummary;
      await clearMessages();
      void AsyncStorage.setItem(CONTEXT_SUMMARY_KEY, data.newContextSummary);
      DeviceEventEmitter.emit(VL_MESSAGES, { messages: [] });
    }

    const um: VoiceMessage = { id: generateId(), role: "user",      text: data.userText,      timestamp: now };
    const am: VoiceMessage = { id: generateId(), role: "assistant", text: data.assistantText, timestamp: now + 1 };
    void addMessage(um);
    void addMessage(am);
    DeviceEventEmitter.emit(VL_MESSAGES, { append: [um, am] });

    if (!_isActive) {
      setStatus("idle");
      await RollingBufferManager.resume();
      await resumeSilentTrack();
      return;
    }

    setStatus("speaking");
    rlog("TTS", "starting playResponseAudio()");
    await playResponseAudio(data.audio);
    rlog("TTS", "playResponseAudio() finished");

    if (_isActive) {
      setStatus("idle");
      rlog("LOOP", "loop continues → startListening(followUp=true)");
      void startListening(true);
    } else {
      setStatus("idle");
      await RollingBufferManager.resume();
      await resumeSilentTrack();
    }

  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (!isAbort) {
      const msg = err instanceof Error ? err.message : "Error desconocido";
      rerror("API", `sendCurrentRecording CATCH: ${msg}`);
      emitError("Error", `No se pudo procesar: ${msg}`);
    } else {
      rlog("API", "fetch aborted (session stopped)");
    }
    setStatus("idle");
    await RollingBufferManager.resume();
    await resumeSilentTrack();
    if (_isActive && !isAbort) {
      rlog("LOOP", "error recovery — startListening() in 1s");
      setTimeout(() => { void startListening(); }, 1000);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startVoiceLoop(): Promise<void> {
  rlog("LOOP", `startVoiceLoop() — _isActive=${_isActive}`);
  if (_isActive) { rlog("LOOP", "startVoiceLoop() ignored — already active"); return; }
  _isActive = true;
  _micRetryCount = 0;
  try {
    const stored = await AsyncStorage.getItem(CONTEXT_SUMMARY_KEY);
    if (stored) _contextSummary = stored;
  } catch {}
  DeviceEventEmitter.emit(VL_SESSION, { active: true });
  emitDebug("Sesión iniciada");
  await startListening();
}

export async function stopVoiceLoop(): Promise<void> {
  rlog("LOOP", `stopVoiceLoop() — _isActive=${_isActive} status=${_status}`);
  if (!_isActive) { rlog("LOOP", "stopVoiceLoop() ignored — already inactive"); return; }
  _isActive = false;
  _startListeningInFlight = false; // cancel any in-flight mic open
  DeviceEventEmitter.emit(VL_SESSION, { active: false });

  clearMaxTimer();
  clearFollowUpTimer();
  if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }
  if (_playbackResolve) { _playbackResolve(); _playbackResolve = null; }

  await stopCurrentRecording();

  if (_sound !== null) {
    try { await _sound.stopAsync();   } catch {}
    try { await _sound.unloadAsync(); } catch {}
    _sound = null;
  }

  await RollingBufferManager.resume();
  await resumeSilentTrack();
  setStatus("idle");
  rlog("LOOP", "stopVoiceLoop() ✓ session ended");
  emitDebug("Sesión terminada");
}

export function toggleVoiceLoop(): void {
  rlog("LOOP", `toggleVoiceLoop() — _isActive=${_isActive}`);
  if (_isActive) { void stopVoiceLoop(); } else { void startVoiceLoop(); }
}

export function interruptSpeaking(): void {
  rlog("LOOP", `interruptSpeaking() — status=${_status}`);
  if (_status !== "speaking") return;
  if (_playbackResolve) { _playbackResolve(); _playbackResolve = null; }
}

export function getVoiceLoopSnapshot(): { status: VoiceLoopStatus; isActive: boolean } {
  return { status: _status, isActive: _isActive };
}

export function updateLoopSettings(settings: { voice: string; language: string }): void {
  void AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
