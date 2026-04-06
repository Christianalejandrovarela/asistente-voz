import TrackPlayer, { Event } from "react-native-track-player";
import { toggleVoiceLoop } from "./voiceLoopService";
import { rlog, rwarn } from "./remoteLogger";

/**
 * Generates a short 440 Hz sine-wave beep as a base64-encoded WAV string.
 * 0.4 s long with 50 ms fade-in/out to avoid clicks.
 * Runs entirely in JS — works in the headless PlaybackService context.
 */
function generateBeepWavBase64(
  freq = 440,
  durationSec = 0.4,
  sampleRate = 16000
): string {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const ws = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ws(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ws(36, "data");
  view.setUint32(40, dataSize, true);

  const fadeSamples = Math.floor(sampleRate * 0.05);
  for (let i = 0; i < numSamples; i++) {
    const fade = Math.min(1, Math.min(i, numSamples - 1 - i) / fadeSamples);
    const s = Math.floor(fade * 0.6 * 32767 * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    view.setInt16(44 + i * 2, s, true);
  }

  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  if (typeof btoa === "function") return btoa(bin);

  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let res = "";
  let i = 0;
  while (i < bin.length) {
    const a = bin.charCodeAt(i++);
    const b = i < bin.length ? bin.charCodeAt(i++) : 0;
    const c = i < bin.length ? bin.charCodeAt(i++) : 0;
    const t = (a << 16) | (b << 8) | c;
    res += chars[(t >> 18) & 0x3f];
    res += chars[(t >> 12) & 0x3f];
    res += i - 2 < bin.length ? chars[(t >> 6) & 0x3f] : "=";
    res += i - 1 < bin.length ? chars[t & 0x3f] : "=";
  }
  return res;
}

/**
 * Plays a short confirmation beep from inside the headless PlaybackService
 * BEFORE toggling the voice loop. Gives audible feedback when the screen is off.
 */
async function playConfirmationBeep(): Promise<void> {
  try {
    rlog("BT", "playConfirmationBeep() start");
    const FileSystem = await import("expo-file-system/legacy");
    const { Audio } = await import("expo-av");

    const beepPath = `${FileSystem.cacheDirectory}confirm_beep.wav`;
    await FileSystem.writeAsStringAsync(beepPath, generateBeepWavBase64(), {
      encoding: FileSystem.EncodingType.Base64,
    });

    const { sound } = await Audio.Sound.createAsync(
      { uri: beepPath },
      { shouldPlay: true, volume: 1.0 }
    );
    await new Promise<void>((resolve) => {
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          void sound.unloadAsync();
          resolve();
        }
      });
      setTimeout(resolve, 1500); // safety timeout
    });
    rlog("BT", "playConfirmationBeep() done");
  } catch (err) {
    console.warn("[PlaybackService] Beep failed (non-fatal):", err);
    rwarn("BT", `playConfirmationBeep() FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * DEBOUNCE — Bluetooth headset button guard.
 *
 * Physical headset buttons (and some Android BT stacks) fire the same remote
 * event 2-3 times for a single press within ~200 ms.  Without debouncing this
 * calls toggleVoiceLoop() multiple times, toggling the session on and off and
 * leaving orphaned recording objects.
 *
 * Any event that arrives within TOGGLE_DEBOUNCE_MS of the last accepted event
 * is silently ignored.
 */
const TOGGLE_DEBOUNCE_MS = 500;
let _lastToggleMs = 0;

async function handleToggleEvent(label: string): Promise<void> {
  const now = Date.now();
  const delta = now - _lastToggleMs;
  if (delta < TOGGLE_DEBOUNCE_MS) {
    rwarn("BT", `${label} DEBOUNCED — ${delta}ms < ${TOGGLE_DEBOUNCE_MS}ms threshold, ignored`);
    console.log(`[PlaybackService] ${label} debounced — ignored (${delta} ms since last)`);
    return;
  }
  _lastToggleMs = now;
  rlog("BT", `${label} ACCEPTED — delta=${delta}ms, calling toggleVoiceLoop()`);
  console.log(`[PlaybackService] ${label} accepted`);
  await playConfirmationBeep();
  toggleVoiceLoop();
}

export async function PlaybackService(): Promise<void> {
  /**
   * All headset button events go through handleToggleEvent() which:
   *  1. Debounces phantom presses (< 500 ms apart are ignored)
   *  2. Plays a beep for audible feedback
   *  3. Calls toggleVoiceLoop() in the same JS runtime as the full loop
   */

  TrackPlayer.addEventListener(Event.RemotePlay, async () => {
    void TrackPlayer.play();
    await handleToggleEvent("RemotePlay");
  });

  TrackPlayer.addEventListener(Event.RemotePause, async () => {
    void TrackPlayer.play(); // keep silent track alive
    await handleToggleEvent("RemotePause");
  });

  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    console.log("[PlaybackService] RemoteStop");
    void TrackPlayer.stop();
  });

  /** Single-button headphones send RemoteNext on first press */
  TrackPlayer.addEventListener(Event.RemoteNext, async () => {
    await handleToggleEvent("RemoteNext");
  });

  TrackPlayer.addEventListener(Event.RemotePrevious, async () => {
    await handleToggleEvent("RemotePrevious");
  });

  TrackPlayer.addEventListener(Event.RemoteDuck, async (event) => {
    if (event.permanent || event.paused) {
      await TrackPlayer.pause();
    } else {
      await TrackPlayer.play();
    }
  });

  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, async () => {
    await TrackPlayer.seekTo(0);
    await TrackPlayer.play();
  });
}
