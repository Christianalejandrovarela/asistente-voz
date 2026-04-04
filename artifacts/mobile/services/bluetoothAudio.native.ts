import { NativeModules, Platform } from "react-native";

let scoConnected = false;
let disconnectFired = false;

export function isBluetoothScoAvailable(): boolean {
  return Platform.OS === "android";
}

export async function startBluetoothSco(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  scoConnected = true;
  disconnectFired = false;
  return true;
}

export function stopBluetoothSco(): void {
  scoConnected = false;
}

export function onBluetoothDisconnect(callback: () => void): () => void {
  if (Platform.OS !== "android") return () => {};

  disconnectFired = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const checkConnection = async () => {
    if (disconnectFired) return;
    try {
      const { default: TrackPlayer, State } = await import("react-native-track-player");
      const state = await TrackPlayer.getPlaybackState();
      if (state.state === State.Error || state.state === State.None) {
        disconnectFired = true;
        scoConnected = false;
        if (intervalId) clearInterval(intervalId);
        intervalId = null;
        callback();
      }
    } catch {}
  };

  intervalId = setInterval(checkConnection, 5_000);

  return () => {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    disconnectFired = true;
  };
}

export function isScoConnected(): boolean {
  return scoConnected;
}
