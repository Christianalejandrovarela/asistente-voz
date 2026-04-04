import { NativeModules } from "react-native";
import * as FileSystem from "expo-file-system/legacy";

const NATIVE_MODULE_NAME = "TrackPlayerModule";

let isInitialized = false;
let unsubPlay: (() => void) | null = null;
let unsubPause: (() => void) | null = null;
let unsubToggle: (() => void) | null = null;

function hasNativeModule(): boolean {
  return !!NativeModules[NATIVE_MODULE_NAME];
}

function generateSilentWavBase64(): string {
  const sampleRate = 8000;
  const numSamples = sampleRate * 2;
  const dataSize = numSamples * 2;
  const fileSize = 36 + dataSize;

  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, fileSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  if (typeof btoa === "function") return btoa(binary);

  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  let i = 0;
  while (i < binary.length) {
    const a = binary.charCodeAt(i++);
    const b = i < binary.length ? binary.charCodeAt(i++) : 0;
    const c = i < binary.length ? binary.charCodeAt(i++) : 0;
    const triplet = (a << 16) | (b << 8) | c;
    result += chars[(triplet >> 18) & 0x3f];
    result += chars[(triplet >> 12) & 0x3f];
    result += i - 2 < binary.length ? chars[(triplet >> 6) & 0x3f] : "=";
    result += i - 1 < binary.length ? chars[triplet & 0x3f] : "=";
  }
  return result;
}

export async function setupTrackPlayer(
  onPlay: () => void,
  onPause: () => void,
  onToggle?: () => void
): Promise<boolean> {
  if (!hasNativeModule()) {
    console.log("[TrackPlayer] Native module not available.");
    return false;
  }

  try {
    const { default: TrackPlayer, Event, Capability, RepeatMode } = await import("react-native-track-player");

    if (!isInitialized) {
      console.log("[TrackPlayer] Setting up player...");
      await TrackPlayer.setupPlayer();
      await TrackPlayer.updateOptions({
        // Include Next/Previous so headsets that send those events are captured
        capabilities: [
          Capability.Play,
          Capability.Pause,
          Capability.SkipToNext,
          Capability.SkipToPrevious,
        ],
        compactCapabilities: [Capability.Play, Capability.Pause],
        notificationCapabilities: [Capability.Play, Capability.Pause],
      });

      const silencePath = `${FileSystem.cacheDirectory}silence_track.wav`;
      const silenceBase64 = generateSilentWavBase64();
      await FileSystem.writeAsStringAsync(silencePath, silenceBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      await TrackPlayer.add({
        id: "silence",
        url: silencePath,
        title: "Asistente de Voz IA",
        artist: "Presiona el botón del auricular para activar",
        duration: 2,
      });
      await TrackPlayer.setRepeatMode(RepeatMode.Track);
      await TrackPlayer.play();

      isInitialized = true;
      console.log("[TrackPlayer] Initialized, media session active");
    }

    if (unsubPlay) unsubPlay();
    if (unsubPause) unsubPause();
    if (unsubToggle) unsubToggle();

    const playSubscription = TrackPlayer.addEventListener(Event.RemotePlay, () => {
      console.log("[TrackPlayer] EVENT: RemotePlay received from headset");
      onPlay();
    });
    const pauseSubscription = TrackPlayer.addEventListener(Event.RemotePause, () => {
      console.log("[TrackPlayer] EVENT: RemotePause received from headset");
      onPause();
    });

    unsubPlay = () => playSubscription.remove();
    unsubPause = () => pauseSubscription.remove();

    if (onToggle) {
      const { onRemoteToggle } = await import("./trackPlayerEvents");
      unsubToggle = onRemoteToggle(onToggle);
    }

    return true;
  } catch (err) {
    console.log("[TrackPlayer] Setup failed:", err);
    return false;
  }
}

export async function pauseSilentTrack(): Promise<void> {
  if (!hasNativeModule() || !isInitialized) return;
  try {
    const { default: TrackPlayer } = await import("react-native-track-player");
    await TrackPlayer.pause();
  } catch {}
}

export async function resumeSilentTrack(): Promise<void> {
  if (!hasNativeModule() || !isInitialized) return;
  try {
    const { default: TrackPlayer } = await import("react-native-track-player");
    await TrackPlayer.seekTo(0);
    await TrackPlayer.play();
  } catch {}
}

export async function destroyTrackPlayer(): Promise<void> {
  if (!hasNativeModule()) return;
  try {
    if (unsubPlay) { unsubPlay(); unsubPlay = null; }
    if (unsubPause) { unsubPause(); unsubPause = null; }
    if (unsubToggle) { unsubToggle(); unsubToggle = null; }
    const { default: TrackPlayer } = await import("react-native-track-player");
    await TrackPlayer.reset();
    isInitialized = false;
  } catch {}
}
