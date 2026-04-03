import { NativeModules } from "react-native";

let isInitialized = false;

export async function setupTrackPlayer(
  onPlay: () => void,
  onPause: () => void
): Promise<boolean> {
  if (!NativeModules.TrackPlayer) {
    console.log("TrackPlayer native module not available (requires native build)");
    return false;
  }

  try {
    const { default: TrackPlayer, Event, Capability } = await import("react-native-track-player");

    if (!isInitialized) {
      await TrackPlayer.setupPlayer();
      await TrackPlayer.updateOptions({
        capabilities: [Capability.Play, Capability.Pause],
        compactCapabilities: [Capability.Play, Capability.Pause],
        notificationCapabilities: [Capability.Play, Capability.Pause],
      });
      isInitialized = true;
    }

    TrackPlayer.addEventListener(Event.RemotePlay, () => onPlay());
    TrackPlayer.addEventListener(Event.RemotePause, () => onPause());

    return true;
  } catch (err) {
    console.log("TrackPlayer setup failed:", err);
    return false;
  }
}

export async function destroyTrackPlayer(): Promise<void> {
  if (!NativeModules.TrackPlayer) return;
  try {
    const { default: TrackPlayer } = await import("react-native-track-player");
    await TrackPlayer.reset();
    isInitialized = false;
  } catch {}
}
