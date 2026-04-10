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
import { startSco, waitForScoConnected, stopSco } from "@/services/bluetoothScoService";
import {
  getUserProfile,
  applyProfileUpdates,
  type ProfileUpdate,
} from "@/services/userProfileService";

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
// Extended from 7 s → 15 s: with screen off the user needs more time to
// react after the "Dime, te escucho" greeting before the follow-up window closes.
const FOLLOW_UP_MS        = 15_000;
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
// JS-level CPU keep-alive for the ENTIRE voice session (start → stop).
// Fires every 250 ms to keep the Samsung One UI JS thread warm regardless of
// what phase the loop is in (recording, API call, TTS, audioFlush…).
// A true PARTIAL_WAKE_LOCK is also held by the BackgroundService (wakeLock:true).
// NEVER stopped mid-session — only in stopVoiceLoop().
let _cpuKeepAlive: ReturnType<typeof setInterval> | null = null;
// TTS playing watchdog: screen-off can freeze onPlaybackStatusUpdate callbacks,
// leaving the loop stuck in "speaking" forever.  Polls the sound every 2.5 s
// and force-resolves playback if the audio has finished without a callback.
let _speakingWatchdog: ReturnType<typeof setInterval> | null = null;
// Idle MediaSession watchdog: fires every 8 s between sessions to force the
// RNTP silent track back into "playing" state in case Android stole audio
// focus (e.g. from a RemoteDuck event fired while we were recording/speaking).
// This keeps the MediaSession active so BT button events keep arriving.
let _idleWatchdog: ReturnType<typeof setInterval> | null = null;
let _recording:  Audio.Recording | null = null;
let _sound:      Audio.Sound | null = null;
let _abortCtrl:  AbortController | null = null;
let _maxTimer:   ReturnType<typeof setTimeout> | null = null;
let _followUpTimer: ReturnType<typeof setTimeout> | null = null;
let _micRetryCount = 0;
let _playbackResolve: (() => void) | null = null;
let _bargeinFlag = false; // set by interruptSpeaking() to abort sentence playback loop
let _contextSummary = "";
// Pre-warmed base64 audio of the error message "Hubo un error de conexión…"
// Fetched once on startup; played locally on API errors — no network needed.
let _errorAudioCache: string | null = null;
// Pre-warmed base64 audio of "¿Sigues ahí?" played on silence timeout.
let _silenceAudioCache: string | null = null;
// Safety net: auto-release the mutex after 30 s if something prevents the
// normal release paths from running.  Prevents permanent loop lockout.
let _inFlightMutexTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// ─── Pre-warm greeting + error TTS caches ────────────────────────────────────
// Fire-and-forget on module load.  Fetches:
//   1. Greeting audio → server caches it so first press plays instantly.
//   2. Error audio    → stored in _errorAudioCache; played locally when the
//      API is unreachable — zero network dependency at error-playback time.
setTimeout(() => {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  const base   = domain ? `https://${domain}` : `http://localhost:8080`;
  // Greeting — just warm the server-side cache
  fetch(`${base}/api/voice/greeting?voice=nova`).catch(() => {});
  // Error TTS — store the base64 locally so it survives network outages
  fetch(`${base}/api/voice/error?voice=nova`)
    .then((r) => r.json())
    .then((d: { audio?: string }) => {
      if (d.audio) {
        _errorAudioCache = d.audio;
        rlog("CACHE", "error TTS pre-warmed ✓");
      }
    })
    .catch(() => {}); // non-fatal — will skip TTS on first error only
  // Silence nudge TTS — "¿Sigues ahí?"
  fetch(`${base}/api/voice/prompt?voice=nova`)
    .then((r) => r.json())
    .then((d: { audio?: string }) => {
      if (d.audio) {
        _silenceAudioCache = d.audio;
        rlog("CACHE", "silence TTS pre-warmed ✓");
      }
    })
    .catch(() => {});
}, 3000); // 3s after module loads so the app finishes initializing first

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

/**
 * audioFlush — call after EVERY TTS segment before opening the mic.
 * Resets audio mode to "playback" (shouldDuckAndroid:true) so Samsung One UI
 * can release the recording audio focus cleanly. Without this, Recording.createAsync()
 * fails silently on Samsung devices and the loop dies after the first response.
 */
async function audioFlush(): Promise<void> {
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      ...(Platform.OS === "android" ? {
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      } : {}),
    });
  } catch {}
  await RollingBufferManager.resume();
  await resumeSilentTrack();
  await new Promise<void>((res) => setTimeout(res, 350));
}

/**
 * JS-level CPU keep-alive: fires every 500 ms during the recording+API+TTS
 * cycle. This supplements the BackgroundService PARTIAL_WAKE_LOCK (wakeLock:true)
 * to prevent Samsung One UI from freezing the JS thread between audio operations.
 * Released in stopCpuKeepAlive() when the active session ends.
 */
function startCpuKeepAlive(): void {
  if (_cpuKeepAlive) return; // already running
  _cpuKeepAlive = setInterval(() => {
    // No-op touch: keeps the event loop from going idle between mic ops.
    // Samsung One UI aggressively throttles idle JS threads even with wakeLock.
    // 250 ms (was 500) — more aggressive to survive deep Doze between TTS and mic.
    void Date.now();
  }, 250);
  rlog("WAKE", "CPU keep-alive started (250 ms interval)");
}

function stopCpuKeepAlive(): void {
  if (_cpuKeepAlive) {
    clearInterval(_cpuKeepAlive);
    _cpuKeepAlive = null;
    rlog("WAKE", "CPU keep-alive stopped");
  }
}

/**
 * Idle MediaSession watchdog — runs between voice sessions.
 * Every 8 s it forces the RNTP silent track back into "playing" so the
 * Android MediaSession stays active and BT button events keep arriving.
 * If audio focus was stolen while we were recording/speaking, Android may
 * have paused the silent track and never auto-resumed it.  This corrects that.
 */
function startIdleWatchdog(): void {
  if (_idleWatchdog) return;
  _idleWatchdog = setInterval(() => {
    if (_isActive) { stopIdleWatchdog(); return; } // session started, stop watchdog
    rlog("WATCH", "idle watchdog — forcing resumeSilentTrack()");
    void resumeSilentTrack();
  }, 8_000);
  rlog("WATCH", "idle watchdog started (8 s interval)");
}

function stopIdleWatchdog(): void {
  if (_idleWatchdog) {
    clearInterval(_idleWatchdog);
    _idleWatchdog = null;
    rlog("WATCH", "idle watchdog stopped");
  }
}

/**
 * Call this once after TrackPlayer finishes initializing to arm the idle
 * watchdog immediately. Keeps the MediaSession alive from first launch.
 */
export function initIdleWatchdog(): void {
  startIdleWatchdog();
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

function stopSpeakingWatchdog(): void {
  if (_speakingWatchdog) {
    clearInterval(_speakingWatchdog);
    _speakingWatchdog = null;
  }
}

async function playResponseAudio(base64Audio: string): Promise<void> {
  if (_sound !== null) {
    rlog("TTS", "playResponseAudio() — cleaning up previous sound");
    try { await _sound.stopAsync();   } catch {}
    try { await _sound.unloadAsync(); } catch {}
    _sound = null;
  }

  // FIX 1 — STREAM_MUSIC / A2DP for full volume:
  // playThroughEarpieceAndroid:false → AudioManager MODE_NORMAL → Android routes
  // TTS through STREAM_MUSIC at full media volume (A2DP BT or loudspeaker).
  // Previously true (MODE_IN_COMMUNICATION / SCO narrow-band) caused low volume
  // because BT SCO is a 8-16 kHz call-grade codec, not a media codec.
  // shouldDuckAndroid:false → AUDIOFOCUS_GAIN (exclusive full-priority focus).
  rlog("TTS", "playResponseAudio() — setAudioModeAsync (shouldDuck=false, earpiece=false→STREAM_MUSIC)");
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
    ...(Platform.OS === "android" ? {
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
    } : {}),
  });

  // Fixed filename — overwritten each turn so no orphaned files accumulate
  // in the cache dir even if a previous error skipped the finally block.
  const tmpPath = `${FileSystem.cacheDirectory ?? ""}ai_tts_response.mp3`;
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

    // FIX 3 — Speaking watchdog (anti-freeze on screen-off):
    // onPlaybackStatusUpdate callbacks stop firing when the screen is off on
    // Samsung One UI, leaving the loop permanently stuck in "speaking".
    // Every 2.5 s we poll getStatusAsync() directly and force-resolve if the
    // audio is done.  This is the safety net when the callback path is frozen.
    stopSpeakingWatchdog(); // clear any stale watchdog from a previous cycle
    _speakingWatchdog = setInterval(async () => {
      if (!_sound) {
        // Sound was cleared externally (barge-in / stopVoiceLoop) — resolve now.
        rlog("TTS", "watchdog: _sound=null → force-resolving playback");
        stopSpeakingWatchdog();
        resolvePlayback();
        return;
      }
      try {
        const st = await _sound.getStatusAsync();
        if (!st.isLoaded) {
          rlog("TTS", "watchdog: sound not loaded → force-resolving");
          stopSpeakingWatchdog();
          resolvePlayback();
        } else {
          const finished =
            st.didJustFinish ||
            (!st.isPlaying &&
              st.positionMillis > 0 &&
              st.durationMillis !== undefined &&
              st.positionMillis >= st.durationMillis - 300);
          if (finished) {
            rlog("TTS", `watchdog: sound finished (pos=${st.positionMillis}ms) → force-resolving`);
            stopSpeakingWatchdog();
            resolvePlayback();
          }
        }
      } catch {
        rlog("TTS", "watchdog: getStatusAsync threw → force-resolving");
        stopSpeakingWatchdog();
        resolvePlayback();
      }
    }, 2500);

    const safety = new Promise<void>((res) => setTimeout(res, 45_000));
    await Promise.race([done, safety]);

    stopSpeakingWatchdog(); // always clean up after playback resolves
    _playbackResolve = null;
    try { await sound.stopAsync();   } catch {}
    try { await sound.unloadAsync(); } catch {}
    _sound = null;
    rlog("TTS", "playResponseAudio() ✓ done");
  } finally {
    stopSpeakingWatchdog();
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

  // ── Mutex safety net ───────────────────────────────────────────────────────
  // If neither the normal release path (line below after createAsync) nor the
  // catch block fires within 30 s, force-release the mutex and retry.
  // Prevents a one-time stuck state from permanently killing the session.
  if (_inFlightMutexTimer) clearTimeout(_inFlightMutexTimer);
  _inFlightMutexTimer = setTimeout(() => {
    if (_startListeningInFlight) {
      rwarn("MIC", "mutex STUCK for 30s — force-releasing and restarting");
      _startListeningInFlight = false;
      _inFlightMutexTimer = null;
      if (_isActive) setTimeout(() => { void startListening(true); }, 200);
    }
  }, 30_000);

  // Acquire JS-level CPU keep-alive for the full listen→process→speak cycle.
  startCpuKeepAlive();

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
    // Mutex released — recording is live; cancel the safety-net timer.
    _startListeningInFlight = false;
    if (_inFlightMutexTimer) { clearTimeout(_inFlightMutexTimer); _inFlightMutexTimer = null; }

    let hasSpeech       = false;
    let silenceStart: number | null = null;
    let speechStart: number | null = null;
    let vadTriggered    = false;

    if (isFollowUp) {
      // ── CONTINUOUS LOOP: silence timeout restarts the mic, never kills session ──
      // If no speech is detected within FOLLOW_UP_MS, we silently stop this
      // recording and immediately reopen the mic so the user can speak at any
      // time.  The session stays alive until the button is pressed again.
      _followUpTimer = setTimeout(async () => {
        if (!hasSpeech && !vadTriggered && _isActive) {
          rlog("VAD", "silence timeout — playing nudge then restarting mic");
          recording.setOnRecordingStatusUpdate(null);
          clearMaxTimer();
          vadTriggered = true;

          // Stop and discard this silent recording without sending it to the API.
          try {
            await recording.stopAndUnloadAsync();
          } catch {}
          if (_recording === recording) _recording = null;

          // audioFlush: reset audio mode → playback so RNTP regains audio focus.
          setStatus("idle");
          await audioFlush();

          // Play "¿Sigues ahí?" to let the user know we're still listening.
          if (_isActive && _silenceAudioCache) {
            try {
              setStatus("speaking");
              await playResponseAudio(_silenceAudioCache);
            } catch {}
            await audioFlush();
            if (_isActive) setStatus("idle");
          }

          // Re-open mic with a new silence timer.
          if (_isActive) {
            setTimeout(() => { if (_isActive) void startListening(true); }, 400);
          }
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
    if (_inFlightMutexTimer) { clearTimeout(_inFlightMutexTimer); _inFlightMutexTimer = null; }
    // NOTE: do NOT stop _cpuKeepAlive here — it must stay alive for the whole
    // session (mic retry, API call, TTS, etc.).  Only stopVoiceLoop() stops it.
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
    const [settings, history, userProfile] = await Promise.all([
      getSettings(),
      // Thin client: send only the last 2 exchanges (4 messages) to keep the
      // payload minimal and the round-trip fast.
      getMessages(4),
      getUserProfile(),
    ]);
    const contextText  = RollingBufferManager.getContextText();

    const payload: { role: string; text: string }[] = [];
    if (contextText) payload.push({ role: "user", text: `[Contexto]: ${contextText}` });
    for (const m of history) {
      if (!m.text.startsWith("[contexto]")) payload.push({ role: m.role, text: m.text });
    }

    rlog("API", `fetch POST ${apiUrl} — history=${payload.length} msgs profile=${userProfile.name ?? "(anon)"}`);
    _bargeinFlag = false;
    _abortCtrl = new AbortController();
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio: base64Audio,
        voice: settings.voice,
        language: settings.language,
        history: payload.slice(-4), // thin client: last 2 exchanges
        contextSummary: _contextSummary || undefined,
        userProfile,
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

    // ── Plain JSON response (streaming removed — ReadableStream / getReader()
    // is unreliable in React Native and caused complete TTS silence).
    // The server generates the full TTS in one tts-1 call and returns:
    //   { userText, assistantText, audio: base64mp3, profileUpdates?, newContextSummary? }
    const data = await response.json() as {
      userText: string;
      assistantText: string;
      audio: string;
      profileUpdates?: ProfileUpdate[];
      newContextSummary?: string;
      error?: string;
    };

    if (data.error) throw new Error(data.error);

    const userText      = data.userText      ?? "";
    const assistantText = data.assistantText ?? "";
    const profileUpdates: ProfileUpdate[] = data.profileUpdates ?? [];

    rlog("API", `response OK — user="${userText.slice(0,50)}" asst="${assistantText.slice(0,50)}" audio=${data.audio?.length ?? 0}b64`);

    if (data.newContextSummary) {
      _contextSummary = data.newContextSummary;
      await clearMessages();
      void AsyncStorage.setItem(CONTEXT_SUMMARY_KEY, data.newContextSummary);
      DeviceEventEmitter.emit(VL_MESSAGES, { messages: [] });
    }

    // Apply long-term memory updates (fire-and-forget).
    if (profileUpdates.length) {
      rlog("PROFILE", `${profileUpdates.length} update(s)`);
      void applyProfileUpdates(profileUpdates);
    }

    // Persist messages for UI display.
    if (userText || assistantText) {
      const now = Date.now();
      const um: VoiceMessage = { id: generateId(), role: "user",      text: userText,      timestamp: now };
      const am: VoiceMessage = { id: generateId(), role: "assistant", text: assistantText, timestamp: now + 1 };
      void addMessage(um);
      void addMessage(am);
      DeviceEventEmitter.emit(VL_MESSAGES, { append: [um, am] });
    }

    // FIX 3 (barge-in): check the flag BEFORE playing — user may have pressed
    // the button while the API was processing ("processing" state).
    // Also guard _isActive in case stopVoiceLoop() ran during await fetch().
    if (!_bargeinFlag && _isActive && data.audio) {
      setStatus("speaking");
      rlog("TTS", "playResponseAudio() start");
      await playResponseAudio(data.audio);
      rlog("TTS", "playResponseAudio() done");
    } else {
      rlog("TTS", `TTS skipped — bargeinFlag=${_bargeinFlag} isActive=${_isActive} hasAudio=${!!data.audio}`);
    }
    _bargeinFlag = false;

    // CRITICAL: reset audio mode + RNTP + 350ms settle before opening mic.
    await audioFlush();

    if (_isActive) {
      setStatus("idle");
      rlog("LOOP", "loop continues → startListening(followUp=true)");
      void startListening(true);
    } else {
      setStatus("idle");
    }

  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";

    if (isAbort) {
      setStatus("idle");
      await audioFlush();
      if (_isActive) {
        // Barge-in during "processing": _bargeinFlag was set + fetch aborted,
        // but session is still live → restart mic immediately so the user can speak.
        rlog("API", "fetch aborted — barge-in during processing, restarting mic");
        _bargeinFlag = false;
        void startListening(true);
      } else {
        rlog("API", "fetch aborted — session stopped by user");
      }
      return;
    }

    // ── Network / API error — indestructible loop recovery ────────────────────
    // 1. Log the error (non-fatal).
    // 2. Reset audio state so TTS playback path works.
    // 3. Play the pre-warmed error message ("Hubo un error de conexión…").
    // 4. Restart listening with follow-up timer → loop NEVER dies on its own.
    const msg = err instanceof Error ? err.message : "Error desconocido";
    rerror("API", `sendCurrentRecording CATCH: ${msg}`);

    setStatus("idle");
    await audioFlush();

    if (_isActive) {
      // Play cached error TTS if available — zero network required.
      if (_errorAudioCache) {
        rlog("LOOP", "playing pre-warmed error TTS...");
        try {
          setStatus("speaking");
          await playResponseAudio(_errorAudioCache);
        } catch (e) {
          rwarn("LOOP", `error TTS playback failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        await audioFlush();
        if (_isActive) setStatus("idle");
      }

      // Always restart with follow-up mode so the silence timeout keeps the
      // loop alive and the user can speak again without pressing the button.
      if (_isActive) {
        rlog("LOOP", "error recovery — restarting mic (isFollowUp=true)");
        setTimeout(() => { if (_isActive) void startListening(true); }, 500);
      }
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch and play a short greeting TTS from the server so the user hears
 * audio confirmation immediately when activating with the screen off.
 * Falls back silently if the network call fails.
 */
async function playGreeting(): Promise<void> {
  rlog("GREET", "playGreeting() — fetching TTS...");
  try {
    const settings = await getSettings();
    const domain   = process.env.EXPO_PUBLIC_DOMAIN;
    const apiUrl   = domain
      ? `https://${domain}/api/voice/greeting?voice=${settings.voice}`
      : `http://localhost:8080/api/voice/greeting?voice=${settings.voice}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000); // 5s timeout
    const resp = await fetch(apiUrl, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!resp.ok) { rwarn("GREET", `greeting HTTP ${resp.status}`); return; }
    const { audio } = await resp.json() as { audio: string };
    if (!audio) { rwarn("GREET", "greeting: empty audio"); return; }

    rlog("GREET", "greeting audio received — playing...");
    setStatus("speaking");
    await playResponseAudio(audio);
    rlog("GREET", "greeting played ✓ — audioFlush() next");
    // audioFlush after greeting so the mic opens cleanly on Samsung One UI.
    await audioFlush();
    if (_isActive) setStatus("idle");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    rwarn("GREET", `playGreeting() failed (ok to continue): ${msg}`);
    await audioFlush();
    if (_isActive) setStatus("idle");
  }
}

export async function startVoiceLoop(): Promise<void> {
  rlog("LOOP", `startVoiceLoop() — _isActive=${_isActive}`);
  if (_isActive) { rlog("LOOP", "startVoiceLoop() ignored — already active"); return; }
  stopIdleWatchdog(); // disarm watchdog — session is now live
  _isActive = true;
  _micRetryCount = 0;
  // FIX 2 — WakeLock: start keep-alive NOW (not later in startListening) so the
  // CPU keep-alive covers the greeting TTS, every API round-trip, every TTS, and
  // every mic-open/retry — the full session from start to stopVoiceLoop().
  startCpuKeepAlive();
  try {
    const stored = await AsyncStorage.getItem(CONTEXT_SUMMARY_KEY);
    if (stored) _contextSummary = stored;
  } catch {}
  DeviceEventEmitter.emit(VL_SESSION, { active: true });
  emitDebug("Sesión iniciada");

  // ── Bluetooth SCO: route microphone through BT headset ─────────────────────
  // startSco() registers a BroadcastReceiver for ACTION_SCO_AUDIO_STATE_UPDATED.
  // waitForScoConnected() blocks until the headset confirms SCO is connected
  // (or times out after 3 s → falls back to phone mic transparently).
  await startSco();
  await waitForScoConnected(3000);

  // Play greeting so the user hears audio immediately (critical when screen is off).
  // Then start listening in follow-up mode (7 s window to speak).
  await playGreeting();
  if (!_isActive) return; // user may have stopped the session during greeting
  await startListening(true);
}

export async function stopVoiceLoop(): Promise<void> {
  rlog("LOOP", `stopVoiceLoop() — _isActive=${_isActive} status=${_status}`);
  if (!_isActive) { rlog("LOOP", "stopVoiceLoop() ignored — already inactive"); return; }
  _isActive = false;
  _startListeningInFlight = false; // cancel any in-flight mic open
  stopCpuKeepAlive();              // FIX 2: stop the session-wide keep-alive
  stopSpeakingWatchdog();          // FIX 3: clear TTS watchdog if session stops mid-TTS
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

  // ── CRITICAL: Reset audio mode to normal BEFORE resuming RNTP ─────────────
  // startListening() sets shouldDuckAndroid:false / allowsRecordingIOS:true.
  // If we don't reset here, Android refuses to give audio focus back to RNTP
  // for the silent track → TrackPlayer.play() fails silently → MediaSession
  // goes inactive → BT button events stop arriving on subsequent presses.
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      ...(Platform.OS === "android" ? {
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      } : {}),
    });
    rlog("LOOP", "stopVoiceLoop: audio mode reset to playback ✓");
  } catch (e) {
    rwarn("LOOP", `stopVoiceLoop: setAudioModeAsync failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }

  await RollingBufferManager.resume();
  await resumeSilentTrack();
  setStatus("idle");
  // Release BT SCO audio channel.
  void stopSco();
  // Start the idle watchdog so the MediaSession stays alive between sessions.
  startIdleWatchdog();
  rlog("LOOP", "stopVoiceLoop() ✓ session ended — idle watchdog armed");
  emitDebug("Sesión terminada");
}

export function toggleVoiceLoop(): void {
  rlog("LOOP", `toggleVoiceLoop() — _isActive=${_isActive} status=${_status}`);

  if (!_isActive) {
    // Session is idle → toggle ON
    void startVoiceLoop();
    return;
  }

  if (_status === "speaking") {
    // ── BARGE-IN: AI is talking — interrupt TTS and go back to listening ──────
    // interruptSpeaking() resolves _playbackResolve(), which makes
    // playResponseAudio() return early.  The sendCurrentRecording() code that
    // called await playResponseAudio() then sees _isActive=true and naturally
    // calls startListening() — so the mic opens without any extra work here.
    rlog("LOOP", "toggleVoiceLoop() BARGE-IN — stopping TTS, mic will open automatically");
    interruptSpeaking();
    return;
  }

  if (_status === "processing") {
    // ── API in-flight — set barge-in flag so TTS is skipped when it arrives ──
    // Do NOT call stopVoiceLoop() here — the session continues after API returns.
    rlog("LOOP", "toggleVoiceLoop() during processing — setting bargeinFlag, mic will reopen after API");
    _bargeinFlag = true;
    if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }
    return;
  }

  // Session is active (recording / waiting / idle) → toggle OFF
  void stopVoiceLoop();
}

export function interruptSpeaking(): void {
  rlog("LOOP", `interruptSpeaking() — status=${_status}`);
  if (_status !== "speaking") return;
  // Barge-in: stop the current sentence audio immediately (fire-and-forget)
  // then signal the sentence loop to abort remaining sentences.
  _bargeinFlag = true;
  if (_sound) { void _sound.stopAsync().catch(() => {}); }
  if (_playbackResolve) { _playbackResolve(); _playbackResolve = null; }
}

export function getVoiceLoopSnapshot(): { status: VoiceLoopStatus; isActive: boolean } {
  return { status: _status, isActive: _isActive };
}

export function updateLoopSettings(settings: { voice: string; language: string }): void {
  void AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
