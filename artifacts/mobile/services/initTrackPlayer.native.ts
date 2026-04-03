import TrackPlayer from "react-native-track-player";
import { PlaybackService } from "./trackPlayerService.native";

/**
 * Register the TrackPlayer playback service at module load time (before React renders).
 * This enables Bluetooth headphone controls and lock-screen media controls to work
 * even when the app is in the background.
 *
 * Must be called before setupPlayer() — this module is imported by _layout.tsx.
 */
try {
  TrackPlayer.registerPlaybackService(() => PlaybackService);
} catch {
  // TrackPlayer native module not linked — development build needed.
}
