import TrackPlayer from "react-native-track-player";
import { PlaybackService } from "./trackPlayerService.native";

try {
  TrackPlayer.registerPlaybackService(() => PlaybackService);
} catch {
  // Native module not linked — EAS development build required.
}
