import TrackPlayer from "react-native-track-player";
import { PlaybackService } from "./trackPlayerService.native";

try {
  TrackPlayer.registerPlaybackService(() => PlaybackService);
  console.log("[initTrackPlayer] PlaybackService registered successfully");
} catch (e) {
  console.log("[initTrackPlayer] registerPlaybackService failed:", e);
}
