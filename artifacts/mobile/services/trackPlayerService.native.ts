import TrackPlayer, { Event } from "react-native-track-player";
import { emitRemotePlay, emitRemotePause } from "./trackPlayerEvents";

export async function PlaybackService(): Promise<void> {
  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    console.log("[PlaybackService] RemotePlay received");
    void TrackPlayer.play();
    emitRemotePlay();
  });

  TrackPlayer.addEventListener(Event.RemotePause, () => {
    console.log("[PlaybackService] RemotePause received");
    void TrackPlayer.pause();
    emitRemotePause();
  });

  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    console.log("[PlaybackService] RemoteStop received");
    void TrackPlayer.stop();
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
