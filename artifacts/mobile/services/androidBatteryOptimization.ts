import AsyncStorage from "@react-native-async-storage/async-storage";
import { Alert, Platform } from "react-native";

const BATTERY_OPT_REQUESTED_KEY = "@battery_opt_requested_v2";

/**
 * Requests battery optimization exemption on Android.
 *
 * Two-stage approach:
 * 1. System dialog  — android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
 *    (works on stock Android, Pixel, OnePlus, etc.)
 * 2. Samsung guide  — if the system dialog fails (One UI blocks it silently),
 *    show a manual Alert explaining how to add the app to "Sin restricciones".
 *
 * Only shown once per install.  Must be called while the app is in the
 * foreground (before any backgrounding) so the intent can launch.
 */
export async function requestBatteryOptimizationExemption(): Promise<void> {
  if (Platform.OS !== "android") return;

  try {
    const alreadyRequested = await AsyncStorage.getItem(BATTERY_OPT_REQUESTED_KEY);
    if (alreadyRequested === "true") return;

    let systemDialogShown = false;

    try {
      const IntentLauncher = await import("expo-intent-launcher");
      await IntentLauncher.startActivityAsync(
        "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
        { data: "package:com.asistentevoz.ia" }
      );
      systemDialogShown = true;
      console.log("[BatteryOptimization] System dialog shown");
    } catch (_) {
      // Samsung One UI and some OEMs block this intent — show manual guide instead.
      console.warn("[BatteryOptimization] System intent blocked, showing manual guide");
    }

    if (!systemDialogShown) {
      // Samsung-specific manual guide
      await new Promise<void>((resolve) => {
        Alert.alert(
          "Activar en segundo plano",
          "Para que el asistente funcione con la pantalla apagada:\n\n" +
          "1. Ve a Ajustes del teléfono → Batería\n" +
          "2. Toca «Límites de uso en segundo plano»\n" +
          "3. Busca «Asistente de Voz IA»\n" +
          "4. Selecciona «Sin restricciones»\n\n" +
          "O bien: Ajustes → Aplicaciones → Asistente de Voz IA → Batería → Sin restricciones.",
          [{ text: "Entendido", onPress: resolve }]
        );
      });
    }

    await AsyncStorage.setItem(BATTERY_OPT_REQUESTED_KEY, "true");
  } catch (err) {
    console.warn("[BatteryOptimization] Unexpected error:", err);
    try { await AsyncStorage.setItem(BATTERY_OPT_REQUESTED_KEY, "true"); } catch {}
  }
}

/**
 * Resets the flag so the dialog shows again on next launch.
 * Useful if the user accidentally dismissed it.
 */
export async function resetBatteryOptimizationRequest(): Promise<void> {
  await AsyncStorage.removeItem(BATTERY_OPT_REQUESTED_KEY);
}
