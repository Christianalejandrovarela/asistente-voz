import { NativeModules, Platform } from "react-native";

let isInitialized = false;

export async function setupTrackPlayer(
  onPlay: () => void,
  onPause: () => void
): Promise<boolean> {
  if (Platform.OS === "web") return false;
  if (!NativeModules.TrackPlayer) {
    console.log("TrackPlayer native module not available (requires native build)");
    return false;
  }

  try {
    const TrackPlayer = (await import("react-native-track-player")).default;
    const { Event, Capability } = await import("react-native-track-player");

    if (!isInitialized) {
      await TrackPlayer.setupPlayer();
      await TrackPlayer.updateOptions({
        capabilities: [Capability.Play, Capability.Pause],
        compactCapabilities: [Capability.Play, Capability.Pause],
        notificationCapabilities: [Capability.Play, Capability.Pause],
      });
      isInitialized = true;
    }

    TrackPlayer.addEventListener(Event.RemotePlay, () => {
      onPlay();
    });
    TrackPlayer.addEventListener(Event.RemotePause, () => {
      onPause();
    });

    return true;
  } catch (err) {
    console.log("TrackPlayer setup failed (requires native build):", err);
    return false;
  }
}

export async function destroyTrackPlayer(): Promise<void> {
  if (!NativeModules.TrackPlayer) return;
  try {
    const TrackPlayer = (await import("react-native-track-player")).default;
    await TrackPlayer.reset();
    isInitialized = false;
  } catch {}
}
