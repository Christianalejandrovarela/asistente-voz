import TrackPlayer, { Event } from "react-native-track-player";

/**
 * TrackPlayer playback service handler — runs in a dedicated background thread.
 * Registered via TrackPlayer.registerPlaybackService() in _layout.tsx on native.
 *
 * Handles remote control events from Bluetooth headphones, lock-screen controls,
 * and the Android notification — enabling Bluetooth play/pause to toggle recording.
 *
 * Note: Volume duck/resume is handled here so AI audio is not interrupted by
 * other apps or phone calls.
 */
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
