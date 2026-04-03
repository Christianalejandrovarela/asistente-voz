import TrackPlayer, { Event } from "react-native-track-player";

export async function PlaybackService(): Promise<void> {
  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    void TrackPlayer.play();
  });

  TrackPlayer.addEventListener(Event.RemotePause, () => {
    void TrackPlayer.pause();
  });

  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    void TrackPlayer.stop();
  });

  TrackPlayer.addEventListener(Event.RemoteDuck, async (event) => {
    if (event.permanent || event.paused) {
      await TrackPlayer.pause();
    } else {
      await TrackPlayer.play();
    }
  });
}
