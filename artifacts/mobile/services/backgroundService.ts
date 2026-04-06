import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

import { RollingBufferManager } from "@/services/rollingBufferManager";

const ROLLING_BUFFER_KEY = "@rolling_buffer_active";

export async function startBackgroundService(): Promise<boolean> {
  if (Platform.OS === "web") return false;

  try {
    const BackgroundService = (await import("react-native-background-actions")).default;
    const isRunning = await BackgroundService.isRunning();
    if (isRunning) {
      console.log("[BackgroundService] Already running");
      return true;
    }

    /**
     * The background task must not resolve until BackgroundService.stop() is called.
     * react-native-background-actions terminates the task when the returned promise
     * resolves, so we use an indefinitely-pending promise that only settles when
     * we detect the service has been stopped (checked every 10 seconds).
     *
     * This ensures the Android foreground service and iOS background audio session
     * remain active for the lifetime of the user session (24/7 standby).
     */
    const backgroundTask = async () => {
      await _restoreRollingBufferIfEnabled();

      await new Promise<void>((resolve) => {
        const keepAlive = setInterval(async () => {
          try {
            const running = await BackgroundService.isRunning();
            if (!running) {
              clearInterval(keepAlive);
              await RollingBufferManager.stop();
              resolve();
            }
          } catch {
            clearInterval(keepAlive);
            resolve();
          }
        }, 10_000);
      });
    };

    await BackgroundService.start(backgroundTask, {
      taskName: "VoiceAssistant",
      taskTitle: "Asistente de Voz IA",
      taskDesc: "Presiona el botón del auricular para activar",
      taskIcon: {
        name: "ic_launcher",
        type: "mipmap",
      },
      color: "#4f6ef7",
      linkingURI: "mobile:///",
      progressBar: {
        max: 100,
        value: 0,
        indeterminate: true,
      },
    });

    console.log("[BackgroundService] Started successfully");
    return true;
  } catch (err) {
    console.log("[BackgroundService] Setup failed:", err);
    return false;
  }
}

export async function stopBackgroundService(): Promise<void> {
  try {
    const BackgroundService = (await import("react-native-background-actions")).default;
    await BackgroundService.stop();
  } catch {}
}

async function _restoreRollingBufferIfEnabled(): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(ROLLING_BUFFER_KEY);
    if (stored === "true") {
      await RollingBufferManager.start();
    }
  } catch (err) {
    console.warn("[BackgroundService] Failed to restore rolling buffer:", err);
  }
}
