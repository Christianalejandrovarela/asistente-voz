import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

const BATTERY_OPT_REQUESTED_KEY = "@battery_opt_requested_v1";

/**
 * On Android, requests the user to disable battery optimization for this app.
 * This prevents Doze Mode from pausing the JS thread and killing audio recording
 * while the screen is off.
 *
 * Only shown once per installation.
 */
export async function requestBatteryOptimizationExemption(): Promise<void> {
  if (Platform.OS !== "android") return;

  try {
    const alreadyRequested = await AsyncStorage.getItem(BATTERY_OPT_REQUESTED_KEY);
    if (alreadyRequested === "true") return;

    const IntentLauncher = await import("expo-intent-launcher");
    await IntentLauncher.startActivityAsync(
      "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      { data: "package:com.asistentevoz.ia" }
    );

    await AsyncStorage.setItem(BATTERY_OPT_REQUESTED_KEY, "true");
    console.log("[BatteryOptimization] User shown battery optimization exemption dialog");
  } catch (err) {
    console.warn("[BatteryOptimization] Could not request exemption:", err);
    try {
      await AsyncStorage.setItem(BATTERY_OPT_REQUESTED_KEY, "true");
    } catch {}
  }
}
