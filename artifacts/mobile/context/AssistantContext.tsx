import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, DeviceEventEmitter } from "react-native";

import { Audio } from "expo-av";
import { setupTrackPlayer, destroyTrackPlayer } from "@/services/trackPlayer";
import { startBackgroundService } from "@/services/backgroundService";
import { requestBatteryOptimizationExemption } from "@/services/androidBatteryOptimization";
import { initDb, getMessages, clearMessages, startAutoPurge, stopAutoPurge } from "@/services/conversationDb";
import { RollingBufferManager } from "@/services/rollingBufferManager";
import { onBluetoothDisconnect } from "@/services/bluetoothAudio";
import {
  startVoiceLoop,
  stopVoiceLoop,
  interruptSpeaking as interruptSpeakingService,
  getVoiceLoopSnapshot,
  updateLoopSettings,
  initIdleWatchdog,
  VoiceLoopStatus,
  VoiceMessage,
  VL_STATUS,
  VL_SESSION,
  VL_MESSAGES,
  VL_DEBUG,
  VL_ERROR,
} from "@/services/voiceLoopService";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AssistantStatus = VoiceLoopStatus;
export type { VoiceMessage as ChatMessage };

export interface AssistantSettings {
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
  language: string;
}

interface RollingBufferContext {
  isActive: boolean;
  getContextText: () => string;
}

interface AssistantContextValue {
  status: AssistantStatus;
  isSessionActive: boolean;
  messages: VoiceMessage[];
  settings: AssistantSettings;
  isBluetoothActive: boolean;
  rollingBuffer: RollingBufferContext;
  debugInfo: string;
  startSession: () => Promise<void>;
  stopSession: () => Promise<void>;
  interruptSpeaking: () => void;
  clearHistory: () => void;
  updateSettings: (settings: Partial<AssistantSettings>) => void;
  toggleRollingBuffer: (enabled: boolean) => Promise<void>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SETTINGS_KEY      = "@voice_assistant_settings";
const ROLLING_BUFFER_KEY = "@rolling_buffer_active";
const CONTEXT_SUMMARY_KEY = "@context_summary";

const DEFAULT_SETTINGS: AssistantSettings = { voice: "nova", language: "es" };

// ─── Context ──────────────────────────────────────────────────────────────────

const AssistantContext = createContext<AssistantContextValue | null>(null);

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  // ── Synced snapshots of voiceLoopService state (for UI display only) ────────
  const snap = getVoiceLoopSnapshot();
  const [status, setStatus]                 = useState<AssistantStatus>(snap.status);
  const [isSessionActive, setIsSessionActive] = useState(snap.isActive);
  const [messages, setMessages]             = useState<VoiceMessage[]>([]);
  const [settings, setSettings]             = useState<AssistantSettings>(DEFAULT_SETTINGS);
  const [isBluetoothActive, setIsBluetoothActive] = useState(false);
  const [isRollingBufferActive, setIsRollingBufferActive] = useState(false);
  const [debugInfo, setDebugInfo]           = useState("Iniciando...");

  // ── Load persisted data ──────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        await initDb();
        const [storedMsgs, storedSettings] = await Promise.all([
          getMessages(50),
          AsyncStorage.getItem(SETTINGS_KEY),
        ]);
        setMessages(storedMsgs as VoiceMessage[]);
        if (storedSettings) {
          const parsed = JSON.parse(storedSettings) as AssistantSettings;
          setSettings(parsed);
        }
      } catch (err) {
        console.error("[AssistantContext] Failed to load persisted data:", err);
      }
    };
    void load();
  }, []);

  // ── Rolling buffer restore ────────────────────────────────────────────────
  useEffect(() => {
    const restoreBuffer = async () => {
      try {
        const stored = await AsyncStorage.getItem(ROLLING_BUFFER_KEY);
        if (stored === "true") {
          const ok = await RollingBufferManager.start();
          setIsRollingBufferActive(ok);
        }
      } catch {}
    };
    void restoreBuffer();
  }, []);

  // ── Periodic message pruning ───────────────────────────────────────────────
  useEffect(() => {
    startAutoPurge();
    const pruneUI = setInterval(() => {
      const cutoff = Date.now() - 10 * 60 * 1000;
      setMessages((prev) => prev.filter((m) => m.timestamp >= cutoff));
    }, 60_000);
    return () => {
      stopAutoPurge();
      clearInterval(pruneUI);
    };
  }, []);

  // ── Subscribe to voiceLoopService events ──────────────────────────────────
  useEffect(() => {
    const subs = [
      DeviceEventEmitter.addListener(VL_STATUS, ({ status: s }: { status: AssistantStatus }) => {
        setStatus(s);
      }),
      DeviceEventEmitter.addListener(VL_SESSION, ({ active }: { active: boolean }) => {
        setIsSessionActive(active);
      }),
      DeviceEventEmitter.addListener(VL_MESSAGES, (payload: { messages?: VoiceMessage[]; append?: VoiceMessage[] }) => {
        if (payload.messages !== undefined) {
          // Full replace (e.g. after context compression)
          setMessages(payload.messages);
        } else if (payload.append) {
          setMessages((prev) => [...prev, ...payload.append!]);
        }
      }),
      DeviceEventEmitter.addListener(VL_DEBUG, ({ info }: { info: string }) => {
        setDebugInfo(info);
      }),
      DeviceEventEmitter.addListener(VL_ERROR, ({ title, body }: { title: string; body: string }) => {
        Alert.alert(title, body, [{ text: "OK" }]);
      }),
    ];

    // Sync React state with any loop activity that started before this mount
    const { status: s, isActive } = getVoiceLoopSnapshot();
    setStatus(s);
    setIsSessionActive(isActive);

    return () => { subs.forEach((s) => s.remove()); };
  }, []);

  // ── TrackPlayer + BackgroundService init ──────────────────────────────────
  useEffect(() => {
    let btCleanup: (() => void) | null = null;

    const init = async () => {
      // ── STEP 1: Request RECORD_AUDIO permission FIRST ───────────────────────
      // Android 14+ throws SecurityException if a Foreground Service with
      // foregroundServiceType=microphone starts before RECORD_AUDIO is granted.
      // This is the most common cause of immediate crash on Samsung Galaxy.
      setDebugInfo("Solicitando permisos...");
      const { status: micStatus } = await Audio.requestPermissionsAsync();
      if (micStatus !== "granted") {
        setDebugInfo("Permiso de micrófono denegado");
        Alert.alert(
          "Permiso de micrófono requerido",
          "Esta app necesita acceso al micrófono para hablar con el asistente.\n\nVe a Ajustes → Aplicaciones → Asistente de Voz IA → Permisos → Micrófono y actívalo.",
          [{ text: "OK" }]
        );
        return;
      }

      // ── STEP 2: Battery optimization exemption (before FGS start) ──────────
      // On Samsung One UI, this opens the "Unmonitored apps" dialog.
      // Must be called while the app is in foreground (before backgrounding).
      await requestBatteryOptimizationExemption();

      // ── STEP 3: Start TrackPlayer + Background Foreground Service ───────────
      // Safe now that RECORD_AUDIO is granted — no more SecurityException crash.
      setDebugInfo("Configurando TrackPlayer...");
      let btOk = false;
      try {
        const [tpResult] = await Promise.all([
          // onPlay/onPause are no-ops here — the headset button is handled by
          // PlaybackService which calls toggleVoiceLoop() directly.
          setupTrackPlayer(() => {}, () => {}),
          startBackgroundService(),
        ]);
        btOk = tpResult;
        setDebugInfo(btOk ? "TrackPlayer OK" : "TrackPlayer no disponible");
        if (btOk) {
          // Arm the idle watchdog immediately so the MediaSession stays alive
          // from first launch — not just after the first completed session.
          initIdleWatchdog();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setDebugInfo(`Error TrackPlayer: ${msg}`);
      }
      setIsBluetoothActive(btOk);

      if (btOk) {
        btCleanup = onBluetoothDisconnect(() => {
          void stopVoiceLoop();
          setDebugInfo("Auricular desconectado");
        });
      }
    };
    void init();

    return () => {
      if (btCleanup) btCleanup();
      void destroyTrackPlayer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Public API ────────────────────────────────────────────────────────────

  const startSession = useCallback(async () => {
    await startVoiceLoop();
  }, []);

  const stopSession = useCallback(async () => {
    await stopVoiceLoop();
  }, []);

  const interruptSpeaking = useCallback(() => {
    interruptSpeakingService();
  }, []);

  const clearHistory = useCallback(() => {
    setMessages([]);
    void clearMessages();
    void AsyncStorage.removeItem(CONTEXT_SUMMARY_KEY);
  }, []);

  const updateSettings = useCallback((newSettings: Partial<AssistantSettings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...newSettings };
      updateLoopSettings(updated);
      return updated;
    });
  }, []);

  const toggleRollingBuffer = useCallback(async (enabled: boolean) => {
    if (enabled) {
      const ok = await RollingBufferManager.start();
      if (!ok) {
        Alert.alert(
          "Permiso de micrófono",
          "Para la grabación continua necesitas conceder acceso al micrófono en los ajustes.",
          [{ text: "OK" }]
        );
        return;
      }
      setIsRollingBufferActive(true);
      await AsyncStorage.setItem(ROLLING_BUFFER_KEY, "true");
    } else {
      await RollingBufferManager.stop();
      setIsRollingBufferActive(false);
      await AsyncStorage.setItem(ROLLING_BUFFER_KEY, "false");
    }
  }, []);

  const rollingBuffer: RollingBufferContext = {
    isActive: isRollingBufferActive,
    getContextText: () => RollingBufferManager.getContextText(),
  };

  return (
    <AssistantContext.Provider
      value={{
        status,
        isSessionActive,
        messages,
        settings,
        isBluetoothActive,
        rollingBuffer,
        debugInfo,
        startSession,
        stopSession,
        interruptSpeaking,
        clearHistory,
        updateSettings,
        toggleRollingBuffer,
      }}
    >
      {children}
    </AssistantContext.Provider>
  );
}

export function useAssistant() {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used within AssistantProvider");
  return ctx;
}
