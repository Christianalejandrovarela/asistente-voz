import { NativeModules } from "react-native";
import TrackPlayer from "react-native-track-player";
import { PlaybackService } from "./trackPlayerService.native";

if (NativeModules.TrackPlayerModule) {
  try {
    TrackPlayer.registerPlaybackService(() => PlaybackService);
    console.log("[initTrackPlayer] PlaybackService registered successfully");
  } catch (e) {
    console.log("[initTrackPlayer] registerPlaybackService failed:", e);
  }
} else {
  console.log("[initTrackPlayer] TrackPlayerModule not available in NativeModules");
}
