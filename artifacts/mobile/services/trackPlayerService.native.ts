import TrackPlayer, { Event } from "react-native-track-player";
import { emitRemotePlay, emitRemotePause, emitRemoteToggle } from "./trackPlayerEvents";

/**
 * Generates a short 440 Hz sine-wave beep as a base64-encoded WAV string.
 * The beep is 0.4 s long with 50 ms fade-in/out to avoid clicks.
 * This runs entirely in JS (no native dependencies) so it works in the
 * headless PlaybackService context.
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
 * Plays a short confirmation beep directly from the headless PlaybackService
 * context, BEFORE emitting the toggle event.
 *
 * This gives the user audible feedback that the button press was registered
 * even when the screen is off and the React UI is suspended.
 *
 * Uses expo-av (native module — works in headless JS) and expo-file-system to
 * write the generated WAV to the cache directory.
 */
async function playConfirmationBeep(): Promise<void> {
  try {
    const FileSystem = await import("expo-file-system/legacy");
    const { Audio } = await import("expo-av");

    const beepPath = `${FileSystem.cacheDirectory}confirm_beep.wav`;
    const beepBase64 = generateBeepWavBase64();
    await FileSystem.writeAsStringAsync(beepPath, beepBase64, {
      encoding: FileSystem.EncodingType.Base64,
    });

    const { sound } = await Audio.Sound.createAsync({ uri: beepPath }, { shouldPlay: true, volume: 1.0 });
    await new Promise<void>((resolve) => {
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          void sound.unloadAsync();
          resolve();
        }
      });
      // Safety timeout in case the callback never fires
      setTimeout(resolve, 1500);
    });
  } catch (err) {
    console.warn("[PlaybackService] Beep failed (non-fatal):", err);
  }
}

/**
 * FIX 3 — Do NOT try to restart the background foreground service from
 * the headless context.  Android 12+ blocks startForegroundService() calls
 * from background (BackgroundServiceStartNotAllowedException).
 *
 * The service is started eagerly by AssistantContext while the app is in the
 * foreground. If it somehow died, the user will need to bring the app back to
 * the foreground. Attempting to restart here causes a crash, not a recovery.
 */
async function warnIfBackgroundServiceStopped(): Promise<void> {
  try {
    const BackgroundService = (await import("react-native-background-actions")).default;
    const isRunning = await BackgroundService.isRunning();
    if (!isRunning) {
      console.warn(
        "[PlaybackService] BackgroundService is not running. " +
        "Open the app to re-activate it. " +
        "(Not attempting restart — Android 12+ blocks this from background.)"
      );
    }
  } catch (e) {
    console.warn("[PlaybackService] Could not check BackgroundService:", e);
  }
}

export async function PlaybackService(): Promise<void> {
  /**
   * RemotePlay — headphone single press (play action from media notification).
   * Play a beep first so the user hears feedback with screen off, then emit
   * the toggle so AssistantContext starts the recording session.
   */
  TrackPlayer.addEventListener(Event.RemotePlay, async () => {
    console.log("[PlaybackService] RemotePlay received");
    void TrackPlayer.play();
    void warnIfBackgroundServiceStopped();
    await playConfirmationBeep();
    emitRemotePlay();
    emitRemoteToggle();
  });

  TrackPlayer.addEventListener(Event.RemotePause, async () => {
    console.log("[PlaybackService] RemotePause received");
    void TrackPlayer.play();
    void warnIfBackgroundServiceStopped();
    await playConfirmationBeep();
    emitRemotePause();
    emitRemoteToggle();
  });

  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    console.log("[PlaybackService] RemoteStop received");
    void TrackPlayer.stop();
  });

  /**
   * Single-button headphones send RemoteNext on first press.
   */
  TrackPlayer.addEventListener(Event.RemoteNext, async () => {
    console.log("[PlaybackService] RemoteNext received (headset single press)");
    void warnIfBackgroundServiceStopped();
    await playConfirmationBeep();
    emitRemoteToggle();
  });

  TrackPlayer.addEventListener(Event.RemotePrevious, async () => {
    console.log("[PlaybackService] RemotePrevious received (headset press)");
    void warnIfBackgroundServiceStopped();
    await playConfirmationBeep();
    emitRemoteToggle();
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
