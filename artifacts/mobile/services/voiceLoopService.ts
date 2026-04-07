/**
 * voiceLoopService.ts — Voice AI State Machine (Build #33)
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  STATE MACHINE DIAGRAM                                               ║
 * ║                                                                      ║
 * ║  IDLE ──[button]──→ WAITING ──[speech]──→ RECORDING                 ║
 * ║   ↑                   ↑                      │                       ║
 * ║   │                   │              [VAD trigger]                   ║
 * ║   │                   │                      ↓                       ║
 * ║   │      [error+TTS]──┤◄────────────── PROCESSING                   ║
 * ║   │   [silence+TTS]───┤                      │                       ║
 * ║   │                   └──[TTS done+flush]── SPEAKING                 ║
 * ║   │                                                                  ║
 * ║   └──────────────────────[button while WAITING/RECORDING]            ║
 * ║                                                                      ║
 * ║  BARGE-IN: button while SPEAKING → interrupt TTS → WAITING          ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * SINGLETON PATTERN
 * ─────────────────
 * All state lives at MODULE level — JS modules are singletons by spec.
 * The same instance is shared between the React UI and the RNTP
 * PlaybackService headless context (same JS runtime, different thread).
 * Audio.Recording and Audio.Sound objects are created once per turn and
 * fully unloaded before the next turn — no object leaks across cycles.
 *
 * FOREGROUND SERVICE + WAKELOCK
 * ──────────────────────────────
 * The RNTP BackgroundService holds a PARTIAL_WAKE_LOCK (wakeLock:true in
 * trackPlayerService). The silent track keeps the MediaSession active so
 * Bluetooth button events arrive even when the screen is off.
 * The JS-level _cpuKeepAlive interval prevents Samsung One UI from
 * throttling the JS thread between audio operations.
 *
 * AUDIO FOCUS PROTOCOL (Samsung One UI critical)
 * ───────────────────────────────────────────────
 * TTS playback:  shouldDuckAndroid:true  (RNTP yields focus)
 * Recording:     shouldDuckAndroid:false (mic grabs exclusive focus)
 * Post-TTS:      explicit reset → shouldDuckAndroid:true + 350ms settle
 *                BEFORE calling Recording.createAsync() — without this
 *                Samsung One UI can't transition audio focus in time and
 *                the recording call fails silently, breaking the loop.
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
import {
  getUserProfile,
  applyProfileUpdates,
  type ProfileUpdate,
} from "@/services/userProfileService";

// ─── Public types ─────────────────────────────────────────────────────────────

export type VoiceLoopStatus =
  | "idle"       // no active session — watchdog running
  | "waiting"    // mic open, awaiting speech (follow-up / silence window)
  | "recording"  // speech detected, actively capturing
  | "processing" // audio sent to API, awaiting response
  | "speaking";  // TTS playing — barge-in button available

export interface VoiceMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

// ─── DeviceEventEmitter event keys ────────────────────────────────────────────

export const VL_STATUS   = "VL_STATUS";
export const VL_SESSION  = "VL_SESSION";
export const VL_MESSAGES = "VL_MESSAGES";
export const VL_DEBUG    = "VL_DEBUG";
export const VL_ERROR    = "VL_ERROR";

// ─── Tuning constants ─────────────────────────────────────────────────────────

const VAD_SILENCE_DB    = -45;    // dB threshold for speech detection
const VAD_SILENCE_MS    = 1500;   // ms of silence after speech to trigger VAD
const VAD_MIN_SPEECH_MS = 300;    // minimum speech duration to avoid false triggers
const MAX_RECORDING_MS  = 60_000; // hard cap on single recording
const FOLLOW_UP_MS      = 15_000; // silence window before "¿Sigues ahí?" nudge
const MAX_MIC_RETRIES   = 3;      // mic open failures before giving up
const HISTORY_MESSAGES  = 10;     // last 5 exchanges (10 msgs) sent to API
const AUDIO_SETTLE_MS   = 350;    // Android audio system settle time after TTS

const SETTINGS_KEY        = "@voice_assistant_settings";
const CONTEXT_SUMMARY_KEY = "@context_summary";

// ─── Module-level state (singleton) ───────────────────────────────────────────

let _state: VoiceLoopStatus = "idle";
let _isActive               = false;
let _micPermissionGranted   = false;

// Mutex: prevents two concurrent startListening() calls from racing.
// Auto-released by safety timer after 30 s in case of unexpected failures.
let _startListeningInFlight = false;
let _inFlightMutexTimer: ReturnType<typeof setTimeout> | null = null;

// Active audio objects — one of each, fully unloaded before next use.
let _recording: Audio.Recording | null = null;
let _sound:     Audio.Sound     | null = null;

// Cancellation handles
let _abortCtrl:      AbortController | null           = null;
let _playbackResolve: (() => void)    | null           = null;
let _maxTimer:       ReturnType<typeof setTimeout> | null = null;
let _followUpTimer:  ReturnType<typeof setTimeout> | null = null;

// Conversation context
let _contextSummary = "";
let _micRetryCount  = 0;

// Pre-warmed TTS audio caches (fetched once on startup, replayed locally).
// These allow playing feedback messages without any API call at runtime.
let _errorAudioCache:   string | null = null; // "Hubo un error de conexión…"
let _silenceAudioCache: string | null = null; // "¿Sigues ahí?"

// Background keepalives
let _cpuKeepAlive: ReturnType<typeof setInterval> | null = null;
let _idleWatchdog: ReturnType<typeof setInterval> | null = null;

// ─── Pre-warm TTS caches on module load ───────────────────────────────────────
// All three short audio clips are fetched once, 3 s after startup, and stored
// locally.  At runtime they play from memory with zero network overhead.

setTimeout(() => {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  const base   = domain ? `https://${domain}` : `http://localhost:8080`;

  // 1. Greeting — server-side cache only (played fresh each session start)
  fetch(`${base}/api/voice/greeting?voice=nova`).catch(() => {});

  // 2. Error TTS — stored locally for offline playback on API failures
  fetch(`${base}/api/voice/error?voice=nova`)
    .then((r) => r.json())
    .then((d: { audio?: string }) => {
      if (d.audio) { _errorAudioCache = d.audio; rlog("CACHE", "error TTS ✓"); }
    })
    .catch(() => {});

  // 3. Silence nudge — stored locally, played on follow-up timeout
  fetch(`${base}/api/voice/prompt?voice=nova`)
    .then((r) => r.json())
    .then((d: { audio?: string }) => {
      if (d.audio) { _silenceAudioCache = d.audio; rlog("CACHE", "silence TTS ✓"); }
    })
    .catch(() => {});
}, 3_000);

// ─── State machine core ───────────────────────────────────────────────────────

/**
 * Single point of state change.  All state transitions go through here so
 * every change is logged with the triggering event for remote debugging.
 */
function transition(newState: VoiceLoopStatus, event: string): void {
  rlog("FSM", `${_state.toUpperCase()} ──[${event}]──→ ${newState.toUpperCase()}`);
  _state = newState;
  DeviceEventEmitter.emit(VL_STATUS, { status: newState });
}

// Backward-compat alias used by UI components that read `status`.
function setStatus(s: VoiceLoopStatus): void { transition(s, "internal"); }

// ─── Timer helpers ────────────────────────────────────────────────────────────

function clearMaxTimer(): void {
  if (_maxTimer) { clearTimeout(_maxTimer); _maxTimer = null; }
}
function clearFollowUpTimer(): void {
  if (_followUpTimer) { clearTimeout(_followUpTimer); _followUpTimer = null; }
}

// ─── CPU keep-alive (JS thread) ───────────────────────────────────────────────
// Supplements the RNTP BackgroundService PARTIAL_WAKE_LOCK.
// Samsung One UI aggressively throttles idle JS threads even with wakeLock:true.

function startCpuKeepAlive(): void {
  if (_cpuKeepAlive) return;
  _cpuKeepAlive = setInterval(() => { void Date.now(); }, 500);
  rlog("WAKE", "CPU keep-alive ▶ started");
}

function stopCpuKeepAlive(): void {
  if (_cpuKeepAlive) {
    clearInterval(_cpuKeepAlive);
    _cpuKeepAlive = null;
    rlog("WAKE", "CPU keep-alive ■ stopped");
  }
}

// ─── Idle watchdog (MediaSession) ─────────────────────────────────────────────
// Between sessions: every 8 s forces the RNTP silent track back to "playing"
// so Android's MediaSession stays active and BT button events keep arriving.

function startIdleWatchdog(): void {
  if (_idleWatchdog) return;
  _idleWatchdog = setInterval(() => {
    if (_isActive) { stopIdleWatchdog(); return; }
    rlog("WATCH", "idle watchdog → resumeSilentTrack()");
    void resumeSilentTrack();
  }, 8_000);
  rlog("WATCH", "idle watchdog ▶ armed");
}

function stopIdleWatchdog(): void {
  if (_idleWatchdog) {
    clearInterval(_idleWatchdog);
    _idleWatchdog = null;
    rlog("WATCH", "idle watchdog ■ disarmed");
  }
}

export function initIdleWatchdog(): void {
  startIdleWatchdog();
}

// ─── Audio helpers ────────────────────────────────────────────────────────────

function emitDebug(info: string): void {
  DeviceEventEmitter.emit(VL_DEBUG, { info });
}

async function getSettings(): Promise<{ voice: string; language: string }> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw) as { voice: string; language: string };
  } catch {}
  return { voice: "nova", language: "es" };
}

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function stopCurrentRecording(): Promise<void> {
  if (!_recording) return;
  const r = _recording;
  _recording = null;
  try {
    r.setOnRecordingStatusUpdate(null);
    await r.stopAndUnloadAsync();
    rlog("MIC", "recording stopped ✓");
  } catch (e) {
    rwarn("MIC", `stopCurrentRecording non-fatal: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Reset audio mode to neutral (playback-friendly, shouldDuck:true) and wait
 * AUDIO_SETTLE_MS for the Android audio system to release the session before
 * the next operation.  Must be called after every TTS playback ends, before
 * opening the microphone.  Without this, Samsung One UI cannot transition
 * audio focus in time and Recording.createAsync() fails silently.
 */
async function audioFlush(resumeRNTP = true): Promise<void> {
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
  } catch (e) {
    rwarn("AUDIO", `audioFlush setAudioMode failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (resumeRNTP) {
    await RollingBufferManager.resume();
    await resumeSilentTrack();
  }
  await new Promise<void>((r) => setTimeout(r, AUDIO_SETTLE_MS));
}

// ─── TTS playback ─────────────────────────────────────────────────────────────

/**
 * Play a base64-encoded MP3 and await its completion.
 * Singleton: unloads any previous sound first.
 * The _playbackResolve hook allows barge-in to interrupt immediately.
 * Safety cap: 45 s max (in case didJustFinish never fires on Android).
 */
async function playResponseAudio(base64Audio: string): Promise<void> {
  // Unload any previous sound (singleton guarantee)
  if (_sound) {
    try { await _sound.stopAsync();   } catch {}
    try { await _sound.unloadAsync(); } catch {}
    _sound = null;
  }

  rlog("TTS", "setAudioMode → playback");
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
    ...(Platform.OS === "android" ? {
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    } : {}),
  });

  // Fixed filename: overwritten each turn, no orphaned files accumulate.
  const tmpPath = `${FileSystem.cacheDirectory ?? ""}ai_tts_response.mp3`;
  try {
    await FileSystem.writeAsStringAsync(tmpPath, base64Audio, { encoding: "base64" });

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
    rlog("TTS", "playing — waiting for onDone...");

    // 45 s cap: if didJustFinish never fires (expo-av/Android bug), bail and
    // continue the loop rather than hanging indefinitely.
    await Promise.race([
      done,
      new Promise<void>((r) => setTimeout(r, 45_000)),
    ]);

    _playbackResolve = null;
    try { await sound.stopAsync();   } catch {}
    try { await sound.unloadAsync(); } catch {}
    _sound = null;
    rlog("TTS", "playback done ✓");
  } finally {
    try { await FileSystem.deleteAsync(tmpPath, { idempotent: true }); } catch {}
  }
}

// ─── Listening (VAD-driven recording) ────────────────────────────────────────

async function startListening(isFollowUp = false): Promise<void> {
  rlog("MIC", `startListening(followUp=${isFollowUp}) state=${_state} active=${_isActive}`);

  if (!_isActive)                  { rlog("MIC", "early-exit: not active");              return; }
  if (_state !== "idle")           { rlog("MIC", `early-exit: state=${_state} ≠ idle`);  return; }
  if (_startListeningInFlight)     { rlog("MIC", "early-exit: mutex locked");             return; }

  _startListeningInFlight = true;

  // Mutex safety net: force-release after 30 s if something prevents normal release.
  if (_inFlightMutexTimer) clearTimeout(_inFlightMutexTimer);
  _inFlightMutexTimer = setTimeout(() => {
    if (_startListeningInFlight) {
      rwarn("MIC", "mutex STUCK 30s — force-releasing");
      _startListeningInFlight = false;
      _inFlightMutexTimer     = null;
      if (_isActive) setTimeout(() => { void startListening(true); }, 200);
    }
  }, 30_000);

  startCpuKeepAlive();

  try {
    // ── Permission ────────────────────────────────────────────────────────────
    if (!_micPermissionGranted) {
      rlog("MIC", "requestPermissionsAsync...");
      const { status } = await Audio.requestPermissionsAsync();
      rlog("MIC", `permission → ${status}`);
      if (status !== "granted") {
        rerror("MIC", "PERMISSION DENIED");
        DeviceEventEmitter.emit(VL_ERROR, { title: "Permiso de micrófono", body: "Activa el micrófono en los ajustes." });
        await stopVoiceLoop();
        return;
      }
      _micPermissionGranted = true;
    } else {
      // Fast path: avoids the 10-16 s Samsung dialog stall on screen-off.
      const { status } = await Audio.getPermissionsAsync();
      if (status !== "granted") {
        _micPermissionGranted = false;
        rerror("MIC", "PERMISSION REVOKED");
        await stopVoiceLoop();
        return;
      }
    }

    clearFollowUpTimer();

    rlog("MIC", "pause RollingBuffer + RNTP");
    await RollingBufferManager.pause();
    await pauseSilentTrack();

    if (_recording) {
      rwarn("MIC", "UNEXPECTED: _recording not null — cleaning up");
      await stopCurrentRecording();
    }

    rlog("MIC", "setAudioMode → recording (shouldDuck:false)");
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      ...(Platform.OS === "android" ? {
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      } : {}),
    });

    rlog("MIC", "Recording.createAsync — opening hardware mic...");
    const { recording } = await Audio.Recording.createAsync(
      { ...Audio.RecordingOptionsPresets.HIGH_QUALITY, isMeteringEnabled: true },
      undefined,
      100
    );
    rlog("MIC", "hardware mic OPEN ✓");

    _recording    = recording;
    _micRetryCount = 0;

    // Release mutex — mic is live from this point on.
    _startListeningInFlight = false;
    if (_inFlightMutexTimer) { clearTimeout(_inFlightMutexTimer); _inFlightMutexTimer = null; }

    transition(isFollowUp ? "waiting" : "recording", "mic-open");

    // ── VAD state ─────────────────────────────────────────────────────────────
    let hasSpeech    = false;
    let silenceStart: number | null = null;
    let speechStart:  number | null = null;
    let vadTriggered = false;

    // ── Follow-up silence timeout ─────────────────────────────────────────────
    if (isFollowUp) {
      _followUpTimer = setTimeout(async () => {
        if (hasSpeech || vadTriggered || !_isActive) return;
        rlog("VAD", `silence timeout (${FOLLOW_UP_MS}ms) — nudging user`);
        recording.setOnRecordingStatusUpdate(null);
        clearMaxTimer();
        vadTriggered = true;

        // Stop silent recording (discard — nothing to send)
        try { await recording.stopAndUnloadAsync(); } catch {}
        if (_recording === recording) _recording = null;

        // Audio flush → then play "¿Sigues ahí?"
        await audioFlush(true);

        if (_isActive && _silenceAudioCache) {
          try {
            transition("speaking", "silence-nudge");
            await playResponseAudio(_silenceAudioCache);
          } catch {}
        }

        // Post-TTS flush → re-open mic
        await audioFlush(true);
        transition("idle", "nudge-done");
        setTimeout(() => { if (_isActive) void startListening(true); }, 400);
      }, FOLLOW_UP_MS);
    }

    // ── VAD callback ─────────────────────────────────────────────────────────
    recording.setOnRecordingStatusUpdate((s) => {
      if (!_isActive || vadTriggered || !s.isRecording) return;

      const db  = s.metering ?? -160;
      const now = Date.now();

      if (db > VAD_SILENCE_DB) {
        if (!hasSpeech) {
          hasSpeech  = true;
          speechStart = now;
          clearFollowUpTimer();
          if (_state === "waiting") transition("recording", "speech-detected");
        }
        silenceStart = null;
      } else if (hasSpeech) {
        if (!silenceStart) silenceStart = now;
        const speechDur = speechStart ? now - speechStart : 0;
        if (now - silenceStart >= VAD_SILENCE_MS && speechDur >= VAD_MIN_SPEECH_MS) {
          vadTriggered = true;
          recording.setOnRecordingStatusUpdate(null);
          clearMaxTimer();
          clearFollowUpTimer();
          rlog("VAD", `trigger — speech=${speechDur}ms silence=${now - silenceStart}ms`);
          void sendCurrentRecording();
        }
      }
    });

    // ── Max-duration safety cap ───────────────────────────────────────────────
    _maxTimer = setTimeout(() => {
      if (!vadTriggered && _isActive && (_state === "recording" || _state === "waiting")) {
        rlog("VAD", "MAX duration hit — sending");
        vadTriggered = true;
        clearFollowUpTimer();
        void sendCurrentRecording();
      }
    }, MAX_RECORDING_MS);

  } catch (err) {
    _startListeningInFlight = false;
    if (_inFlightMutexTimer) { clearTimeout(_inFlightMutexTimer); _inFlightMutexTimer = null; }
    stopCpuKeepAlive();

    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    _micRetryCount++;
    rerror("MIC", `startListening CATCH attempt ${_micRetryCount}/${MAX_MIC_RETRIES}: ${msg}`);
    transition("idle", "mic-error");
    await RollingBufferManager.resume();
    await resumeSilentTrack();

    if (_isActive) {
      if (_micRetryCount < MAX_MIC_RETRIES) {
        const delay = 1_000 * _micRetryCount;
        rlog("MIC", `retry in ${delay}ms`);
        setTimeout(() => { void startListening(true); }, delay);
      } else {
        rerror("MIC", "MAX RETRIES — stopping session");
        DeviceEventEmitter.emit(VL_ERROR, { title: "Error de micrófono", body: msg });
        void stopVoiceLoop();
      }
    }
  }
}

// ─── Send recording → API → TTS → next listen ────────────────────────────────

async function sendCurrentRecordingInner(): Promise<void> {
  rlog("API", `sendCurrentRecording state=${_state}`);
  clearMaxTimer();

  if ((_state !== "recording" && _state !== "waiting") || !_recording) {
    rwarn("API", "early-exit: wrong state or null recording");
    return;
  }

  transition("processing", "vad-triggered");

  const recording = _recording;
  _recording = null;

  try {
    await recording.stopAndUnloadAsync();
    rlog("MIC", "hardware mic released ✓");
  } catch (e) {
    rwarn("MIC", `stopAndUnload non-fatal: ${e instanceof Error ? e.message : String(e)}`);
  }

  const uri = recording.getURI();
  if (!uri) throw new Error("No recording URI after stop");

  const base64Audio = await FileSystem.readAsStringAsync(uri, { encoding: "base64" });
  rlog("API", `audio ${(base64Audio.length * 0.75 / 1024).toFixed(0)} KB → fetch`);

  if (!_isActive) {
    transition("idle", "aborted-before-fetch");
    await audioFlush(true);
    return;
  }

  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  const apiUrl = domain
    ? `https://${domain}/api/voice/chat`
    : "http://localhost:8080/api/voice/chat";

  await purgeOldMessages();
  const [settings, history, userProfile] = await Promise.all([
    getSettings(),
    getMessages(HISTORY_MESSAGES), // last 5 exchanges = 10 messages
    getUserProfile(),
  ]);
  const contextText = RollingBufferManager.getContextText();

  const payload: { role: string; text: string }[] = [];
  if (contextText) payload.push({ role: "user", text: `[Contexto]: ${contextText}` });
  for (const m of history) {
    if (!m.text.startsWith("[contexto]")) payload.push({ role: m.role, text: m.text });
  }

  rlog("API", `POST history=${payload.length} profile=${userProfile.name ?? "anon"}`);
  _abortCtrl = new AbortController();
  const signal = _abortCtrl.signal;

  // Fetch — abort signal propagates AbortError if stopVoiceLoop() fires mid-request.
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio: base64Audio,
      voice: settings.voice,
      language: settings.language,
      history: payload.slice(-HISTORY_MESSAGES),
      contextSummary: _contextSummary || undefined,
      userProfile,
    }),
    signal,
  }).finally(() => { _abortCtrl = null; });

  if (!_isActive) {
    transition("idle", "aborted-after-fetch");
    await audioFlush(true);
    return;
  }

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`API ${response.status}: ${txt}`);
  }

  interface ApiResp {
    audio: string;
    userText: string;
    assistantText: string;
    newContextSummary?: string;
    profileUpdates?: ProfileUpdate[];
  }
  const data = await response.json() as ApiResp;
  rlog("API", `OK user="${data.userText.slice(0, 60)}" asst="${data.assistantText.slice(0, 60)}"`);

  // Profile updates — fire-and-forget, never blocks TTS
  if (data.profileUpdates?.length) {
    rlog("PROFILE", `${data.profileUpdates.length} update(s)`);
    void applyProfileUpdates(data.profileUpdates);
  }

  // Context compression
  if (data.newContextSummary) {
    _contextSummary = data.newContextSummary;
    await clearMessages();
    void AsyncStorage.setItem(CONTEXT_SUMMARY_KEY, data.newContextSummary);
    DeviceEventEmitter.emit(VL_MESSAGES, { messages: [] });
  }

  // Persist conversation messages
  const now = Date.now();
  const um: VoiceMessage = { id: generateId(), role: "user",      text: data.userText,      timestamp: now };
  const am: VoiceMessage = { id: generateId(), role: "assistant", text: data.assistantText, timestamp: now + 1 };
  void addMessage(um);
  void addMessage(am);
  DeviceEventEmitter.emit(VL_MESSAGES, { append: [um, am] });

  if (!_isActive) {
    transition("idle", "aborted-before-tts");
    await audioFlush(true);
    return;
  }

  // ── SPEAKING state: play TTS response ────────────────────────────────────────
  transition("speaking", "api-response");
  rlog("TTS", "→ playResponseAudio");
  await playResponseAudio(data.audio);
  rlog("TTS", "← done");

  // ── CRITICAL post-TTS audio flush ────────────────────────────────────────────
  // Reset audio mode + resume RNTP + AUDIO_SETTLE_MS before opening the mic.
  // Without this, Samsung One UI cannot transition audio focus in time and
  // Recording.createAsync() fails silently on the next turn — breaking the loop.
  await audioFlush(true);

  if (_isActive) {
    transition("idle", "tts-done");
    rlog("LOOP", "→ startListening(followUp=true)");
    void startListening(true);
  }
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

async function playGreeting(): Promise<void> {
  rlog("GREET", "fetching greeting TTS...");
  try {
    const settings = await getSettings();
    const domain   = process.env.EXPO_PUBLIC_DOMAIN;
    const apiUrl   = domain
      ? `https://${domain}/api/voice/greeting?voice=${settings.voice}`
      : `http://localhost:8080/api/voice/greeting?voice=${settings.voice}`;

    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    const resp  = await fetch(apiUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) { rwarn("GREET", `HTTP ${resp.status}`); return; }

    const { audio } = await resp.json() as { audio: string };
    if (!audio) { rwarn("GREET", "empty audio"); return; }

    rlog("GREET", "playing greeting...");
    transition("speaking", "greeting");
    await playResponseAudio(audio);
    rlog("GREET", "greeting done ✓");

    // Post-greeting flush — same protocol as post-response flush.
    if (_isActive) await audioFlush(true);
    if (_isActive) transition("idle", "greeting-done");
  } catch (err) {
    rwarn("GREET", `failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    if (_isActive) transition("idle", "greeting-error");
  }
}

export async function startVoiceLoop(): Promise<void> {
  rlog("LOOP", `startVoiceLoop — active=${_isActive}`);
  if (_isActive) { rlog("LOOP", "already active — ignored"); return; }

  stopIdleWatchdog();
  _isActive       = true;
  _micRetryCount  = 0;

  try {
    const stored = await AsyncStorage.getItem(CONTEXT_SUMMARY_KEY);
    if (stored) _contextSummary = stored;
  } catch {}

  DeviceEventEmitter.emit(VL_SESSION, { active: true });
  emitDebug("Sesión iniciada");

  await playGreeting();
  if (!_isActive) return; // user stopped during greeting
  await startListening(true);
}

export async function stopVoiceLoop(): Promise<void> {
  rlog("LOOP", `stopVoiceLoop — active=${_isActive} state=${_state}`);
  if (!_isActive) { rlog("LOOP", "already stopped — ignored"); return; }

  _isActive               = false;
  _startListeningInFlight = false;
  if (_inFlightMutexTimer) { clearTimeout(_inFlightMutexTimer); _inFlightMutexTimer = null; }
  stopCpuKeepAlive();

  DeviceEventEmitter.emit(VL_SESSION, { active: false });

  clearMaxTimer();
  clearFollowUpTimer();

  // Cancel in-flight API request
  if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }

  // Interrupt any in-progress TTS
  if (_playbackResolve) { _playbackResolve(); _playbackResolve = null; }

  await stopCurrentRecording();

  if (_sound) {
    try { await _sound.stopAsync();   } catch {}
    try { await _sound.unloadAsync(); } catch {}
    _sound = null;
  }

  // Full audio reset before handing control back to RNTP
  await audioFlush(true);
  transition("idle", "session-stopped");
  startIdleWatchdog();
  rlog("LOOP", "session ended — idle watchdog armed");
  emitDebug("Sesión terminada");
}

// ─── Button handler (3 modes) ─────────────────────────────────────────────────
//
//  IDLE     → START session
//  SPEAKING → BARGE-IN: stop TTS instantly, mic opens automatically via the
//             post-TTS code path in sendCurrentRecording() which sees _isActive=true
//  WAITING / RECORDING / PROCESSING → STOP session (release wakelock)

export function toggleVoiceLoop(): void {
  rlog("LOOP", `toggleVoiceLoop — state=${_state} active=${_isActive}`);

  if (_state === "speaking" && _isActive) {
    // BARGE-IN: resolve the playback promise → playResponseAudio() returns →
    // sendCurrentRecording() sees _isActive=true → audioFlush → startListening(true).
    rlog("LOOP", "BARGE-IN — interrupting TTS");
    interruptSpeaking();
  } else if (_isActive) {
    void stopVoiceLoop();
  } else {
    void startVoiceLoop();
  }
}

export function interruptSpeaking(): void {
  rlog("LOOP", `interruptSpeaking — state=${_state}`);
  if (_state !== "speaking") return;
  if (_playbackResolve) { _playbackResolve(); _playbackResolve = null; }
}

// ─── Indestructible loop wrapper ─────────────────────────────────────────────
// sendCurrentRecording is the outer entry point (called by VAD + max timer).
// It wraps the inner logic and handles all errors with TTS feedback + restart.

async function sendCurrentRecording(): Promise<void> {
  try {
    await sendCurrentRecordingInner();
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (isAbort) {
      rlog("API", "fetch aborted — clean shutdown");
      transition("idle", "aborted");
      await audioFlush(true);
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    rerror("API", `CATCH: ${msg}`);

    transition("idle", "error");
    await audioFlush(true);

    if (!_isActive) return;

    // Play cached error TTS — zero network dependency
    if (_errorAudioCache) {
      try {
        transition("speaking", "error-tts");
        await playResponseAudio(_errorAudioCache);
      } catch {}
      await audioFlush(true);
    }

    // Restart with follow-up mode — loop NEVER dies from network errors
    if (_isActive) {
      transition("idle", "error-recovery");
      rlog("LOOP", "error recovery → startListening(followUp=true)");
      setTimeout(() => { if (_isActive) void startListening(true); }, 500);
    }
  }
}

// ─── Public utilities ─────────────────────────────────────────────────────────

export function getVoiceLoopSnapshot(): { status: VoiceLoopStatus; isActive: boolean } {
  return { status: _state, isActive: _isActive };
}

export function updateLoopSettings(settings: { voice: string; language: string }): void {
  void AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
