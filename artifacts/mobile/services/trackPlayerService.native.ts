import TrackPlayer, { Event } from "react-native-track-player";
import { emitRemotePlay, emitRemotePause, emitRemoteToggle } from "./trackPlayerEvents";

/**
 * Attempt to re-arm the background foreground service if it somehow stopped.
 * This happens BEFORE emitting the toggle so the JS thread stays alive for
 * the subsequent recording attempt.
 */
async function ensureBackgroundServiceActive(): Promise<void> {
  try {
    const BackgroundService = (await import("react-native-background-actions")).default;
    const isRunning = await BackgroundService.isRunning();
    if (!isRunning) {
      console.warn("[PlaybackService] BackgroundService not running — restarting...");
      const { startBackgroundService } = await import("./backgroundService");
      await startBackgroundService();
    }
  } catch (e) {
    console.warn("[PlaybackService] Could not check/restart BackgroundService:", e);
  }
}

export async function PlaybackService(): Promise<void> {
  /**
   * RemotePlay — headphone single press (play action from media notification)
   * We re-arm the foreground service first, then emit the toggle so
   * AssistantContext (still mounted in memory while foreground service is alive)
   * can start the recording session.
   */
  TrackPlayer.addEventListener(Event.RemotePlay, async () => {
    console.log("[PlaybackService] RemotePlay received");
    void TrackPlayer.play();
    await ensureBackgroundServiceActive();
    emitRemotePlay();
    emitRemoteToggle();
  });

  TrackPlayer.addEventListener(Event.RemotePause, async () => {
    console.log("[PlaybackService] RemotePause received");
    void TrackPlayer.pause();
    await ensureBackgroundServiceActive();
    emitRemotePause();
    emitRemoteToggle();
  });

  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    console.log("[PlaybackService] RemoteStop received");
    void TrackPlayer.stop();
  });

  /**
   * Single-button headphones send RemoteNext on press.
   * Ensure foreground service is alive before triggering recording.
   */
  TrackPlayer.addEventListener(Event.RemoteNext, async () => {
    console.log("[PlaybackService] RemoteNext received (headset single press)");
    await ensureBackgroundServiceActive();
    emitRemoteToggle();
  });

  TrackPlayer.addEventListener(Event.RemotePrevious, async () => {
    console.log("[PlaybackService] RemotePrevious received (headset press)");
    await ensureBackgroundServiceActive();
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
