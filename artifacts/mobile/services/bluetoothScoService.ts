/**
 * bluetoothScoService.ts
 *
 * JS wrapper around BluetoothScoModule (native Kotlin).
 *
 * Usage:
 *   await startSco();
 *   const connected = await waitForScoConnected(3000); // wait up to 3 s
 *   // ...start recording — audio is now routed through BT headset...
 *   await stopSco();
 */

import { NativeModules, NativeEventEmitter, Platform } from "react-native";
import { rlog, rwarn } from "@/services/remoteLogger";

const { BluetoothScoModule } = NativeModules;

const emitter = BluetoothScoModule
  ? new NativeEventEmitter(BluetoothScoModule)
  : null;

export async function startSco(): Promise<void> {
  if (Platform.OS !== "android" || !BluetoothScoModule) return;
  try {
    await BluetoothScoModule.startSco();
    rlog("SCO", "startSco() called — waiting for BTScoConnected event...");
  } catch (e) {
    rwarn("SCO", `startSco() threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function stopSco(): Promise<void> {
  if (Platform.OS !== "android" || !BluetoothScoModule) return;
  try {
    await BluetoothScoModule.stopSco();
    rlog("SCO", "stopSco() called — SCO audio mode released");
  } catch (e) {
    rwarn("SCO", `stopSco() threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Re-assert MODE_IN_COMMUNICATION + isBluetoothScoOn=true without
 * re-registering the BroadcastReceiver or waiting for BTScoConnected.
 *
 * Call this immediately before every Recording.createAsync() so the mic
 * stays on the BT headset even after expo-av's setAudioModeAsync(MODE_NORMAL)
 * calls (which happen during TTS and audioFlush between turns).
 */
export async function reapplyBtSco(): Promise<void> {
  if (Platform.OS !== "android" || !BluetoothScoModule) return;
  try {
    await BluetoothScoModule.reapplyBtSco();
    rlog("SCO", "reapplyBtSco() → MODE_IN_COMMUNICATION + isBluetoothScoOn=true ✓");
  } catch (e) {
    rwarn("SCO", `reapplyBtSco() threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Wait for the BT headset to fully connect SCO audio.
 * Resolves true  → SCO connected (mic will use BT headset).
 * Resolves false → timeout or no emitter (phone mic fallback).
 */
export function waitForScoConnected(timeoutMs = 3000): Promise<boolean> {
  if (Platform.OS !== "android" || !emitter) return Promise.resolve(false);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.remove();
      rwarn("SCO", `waitForScoConnected() timed out after ${timeoutMs}ms — using phone mic`);
      resolve(false);
    }, timeoutMs);

    const sub = emitter!.addListener("BTScoConnected", () => {
      clearTimeout(timer);
      sub.remove();
      rlog("SCO", "BTScoConnected ✓ — mic routed to BT headset");
      resolve(true);
    });
  });
}
