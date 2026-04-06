/**
 * Custom React Native entry point (native only).
 *
 * WHY THIS FILE EXISTS:
 * TrackPlayer.registerPlaybackService() must be called before AppRegistry
 * registers the root React component.  If it runs inside a React component
 * (or a module first imported by a React component) it may arrive too late
 * for Android to wire up the Headless JS task — causing the headphone button
 * to have no effect when the screen is off.
 *
 * Metro automatically picks index.native.ts over index.ts on iOS/Android.
 */
// ─── 0. Remote logger MUST be initialized first ──────────────────────────────
// Patches console.log/warn/error so [VoiceLoop], [PlaybackService] lines are
// forwarded to the Replit server log in real-time.
import { initRemoteLogger, rlog } from "./services/remoteLogger";
initRemoteLogger();
rlog("BOOT", "index.native.ts loaded — remote logging active");

import TrackPlayer from "react-native-track-player";
import { PlaybackService } from "./services/trackPlayerService.native";

// ─── 1. Register RNTP headless task globally ─────────────────────────────────
// This happens synchronously, before ANY React component mounts, so Android
// can invoke PlaybackService even when the UI has never been shown.
try {
  TrackPlayer.registerPlaybackService(() => PlaybackService);
  console.log("[Entry] PlaybackService registered at global scope");
} catch (e) {
  console.warn("[Entry] registerPlaybackService failed:", e);
}

// ─── 2. Boot Expo Router ──────────────────────────────────────────────────────
import "expo-router/entry";
