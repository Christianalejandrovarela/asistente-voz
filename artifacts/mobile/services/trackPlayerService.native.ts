import TrackPlayer, { Event } from "react-native-track-player";
import { emitRemotePlay, emitRemotePause, emitRemoteToggle } from "./trackPlayerEvents";

export async function PlaybackService(): Promise<void> {
  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    console.log("[PlaybackService] RemotePlay received");
    void TrackPlayer.play();
    emitRemotePlay();
    emitRemoteToggle();
  });

  TrackPlayer.addEventListener(Event.RemotePause, () => {
    console.log("[PlaybackService] RemotePause received");
    void TrackPlayer.pause();
    emitRemotePause();
    emitRemoteToggle();
  });

  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    console.log("[PlaybackService] RemoteStop received");
    void TrackPlayer.stop();
  });

  // Many Bluetooth headphones send RemoteNext on single-button press
  TrackPlayer.addEventListener(Event.RemoteNext, () => {
    console.log("[PlaybackService] RemoteNext received (headset single press)");
    emitRemoteToggle();
  });

  // Some headphones send RemotePrevious on long-press
  TrackPlayer.addEventListener(Event.RemotePrevious, () => {
    console.log("[PlaybackService] RemotePrevious received (headset press)");
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
