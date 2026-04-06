import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

import { RollingBufferManager } from "@/services/rollingBufferManager";
import { rlog } from "@/services/remoteLogger";

const ROLLING_BUFFER_KEY = "@rolling_buffer_active";
const HEARTBEAT_MS = 15_000;

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
     * ANDROID DOZE / CPU-SLEEP PROTECTION
     * ─────────────────────────────────────
     * Three layers keep the JS thread alive when the screen is off:
     *
     * 1. wakeLock: true  — react-native-background-actions acquires a
     *    PARTIAL_WAKE_LOCK so the CPU stays powered even in Doze mode.
     *
     * 2. Heartbeat setInterval (15 s) — constant JS activity prevents
     *    Android from freezing the runtime due to inactivity.  Also
     *    visible in the remote log server as a heartbeat pulse.
     *
     * 3. await new Promise(() => {}) — the task promise NEVER resolves,
     *    so the OS never assumes the background task has finished.
     *    Cleanup happens via BackgroundService.stop() in stopBackgroundService().
     */
    const backgroundTask = async () => {
      await _restoreRollingBufferIfEnabled();

      rlog("BG", "background task started — wakeLock active, heartbeat armed");

      // Heartbeat: keeps JS thread warm, visible in remote logs.
      const heartbeat = setInterval(() => {
        console.log("[Heartbeat] JS Thread alive");
        rlog("HEARTBEAT", "JS Thread alive");
      }, HEARTBEAT_MS);

      // Silence the "unused variable" lint warning — heartbeat intentionally
      // runs for the lifetime of the process.
      void heartbeat;

      // Never resolve: tells the OS this task is permanently ongoing.
      await new Promise<never>(() => {});
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
      // ① WakeLock: keeps CPU awake in Android Doze / deep sleep.
      wakeLock: true,
      progressBar: {
        max: 100,
        value: 0,
        indeterminate: true,
      },
    });

    rlog("BG", "BackgroundService.start() resolved — foreground service notification up");
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
    await RollingBufferManager.stop();
    await BackgroundService.stop();
    rlog("BG", "BackgroundService stopped");
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
