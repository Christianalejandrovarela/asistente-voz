/**
 * Cross-context remote control event bus.
 *
 * Uses DeviceEventEmitter (backed by the React Native native bridge) instead
 * of plain module-level JS callbacks.  This guarantees the events reach all
 * registered listeners even when Android's background-actions or RNTP
 * headless-task contexts emit them, and the main React UI context is the one
 * that has the listeners registered — both sides share the same bridge
 * instance inside the same process.
 */
import { DeviceEventEmitter } from "react-native";

const EV_REMOTE_PLAY   = "RNTP_REMOTE_PLAY";
const EV_REMOTE_PAUSE  = "RNTP_REMOTE_PAUSE";
const EV_REMOTE_TOGGLE = "RNTP_REMOTE_TOGGLE";

export function onRemotePlay(cb: () => void): () => void {
  const sub = DeviceEventEmitter.addListener(EV_REMOTE_PLAY, cb);
  return () => sub.remove();
}

export function onRemotePause(cb: () => void): () => void {
  const sub = DeviceEventEmitter.addListener(EV_REMOTE_PAUSE, cb);
  return () => sub.remove();
}

export function onRemoteToggle(cb: () => void): () => void {
  const sub = DeviceEventEmitter.addListener(EV_REMOTE_TOGGLE, cb);
  return () => sub.remove();
}

export function emitRemotePlay(): void {
  console.log("[TrackPlayerEvents] emitRemotePlay via DeviceEventEmitter");
  DeviceEventEmitter.emit(EV_REMOTE_PLAY);
}

export function emitRemotePause(): void {
  console.log("[TrackPlayerEvents] emitRemotePause via DeviceEventEmitter");
  DeviceEventEmitter.emit(EV_REMOTE_PAUSE);
}

export function emitRemoteToggle(): void {
  console.log("[TrackPlayerEvents] emitRemoteToggle via DeviceEventEmitter");
  DeviceEventEmitter.emit(EV_REMOTE_TOGGLE);
}
