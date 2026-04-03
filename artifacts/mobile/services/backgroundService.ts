import { NativeModules, Platform } from "react-native";

export async function startBackgroundService(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  if (!NativeModules.BackgroundActions) {
    console.log("BackgroundActions native module not available (requires native build)");
    return false;
  }

  try {
    const BackgroundService = (await import("react-native-background-actions")).default;
    const isRunning = await BackgroundService.isRunning();
    if (isRunning) return true;

    const backgroundTask = async (taskData?: { delay?: number }) => {
      const delay = taskData?.delay ?? 30000;
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
        }, delay);
        setTimeout(() => {
          clearInterval(interval);
          resolve();
        }, delay * 100);
      });
    };

    await BackgroundService.start(backgroundTask, {
      taskName: "VoiceAssistant",
      taskTitle: "Asistente de Voz IA",
      taskDesc: "El asistente está listo para escucharte",
      taskIcon: {
        name: "ic_launcher",
        type: "mipmap",
      },
      color: "#4f6ef7",
      parameters: { delay: 30000 },
    });

    return true;
  } catch (err) {
    console.log("BackgroundService setup failed (requires native build):", err);
    return false;
  }
}

export async function stopBackgroundService(): Promise<void> {
  if (!NativeModules.BackgroundActions) return;
  try {
    const BackgroundService = (await import("react-native-background-actions")).default;
    await BackgroundService.stop();
  } catch {}
}
