import AsyncStorage from "@react-native-async-storage/async-storage";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Alert, Platform } from "react-native";

import { setupTrackPlayer, destroyTrackPlayer, pauseSilentTrack, resumeSilentTrack } from "@/services/trackPlayer";
import { startBackgroundService, stopBackgroundService } from "@/services/backgroundService";
import { initDb, getMessages, addMessage, clearMessages, startAutoPurge, stopAutoPurge, purgeOldMessages } from "@/services/conversationDb";
import { RollingBufferManager } from "@/services/rollingBufferManager";
import { onBluetoothDisconnect } from "@/services/bluetoothAudio";

export type AssistantStatus = "idle" | "recording" | "processing" | "speaking";

interface VoiceApiResponse {
  audio: string;
  userText: string;
  assistantText: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

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
  messages: ChatMessage[];
  settings: AssistantSettings;
  isBluetoothActive: boolean;
  rollingBuffer: RollingBufferContext;
  debugInfo: string;
  startSession: () => Promise<void>;
  stopSession: () => Promise<void>;
  clearHistory: () => void;
  updateSettings: (settings: Partial<AssistantSettings>) => void;
  toggleRollingBuffer: (enabled: boolean) => Promise<void>;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

const SETTINGS_KEY = "@voice_assistant_settings";
const ROLLING_BUFFER_KEY = "@rolling_buffer_active";

const DEFAULT_SETTINGS: AssistantSettings = { voice: "nova", language: "es" };

const VAD_SILENCE_THRESHOLD_DB = -45;
const VAD_SILENCE_DURATION_MS = 1500;
const VAD_MIN_SPEECH_MS = 300;
const MAX_RECORDING_MS = 60_000;

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

async function readUriAsBase64(uri: string): Promise<string> {
  if (Platform.OS === "web" || uri.startsWith("blob:")) {
    const resp = await fetch(uri);
    const blob = await resp.blob();
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        resolve(result.split(",")[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  return FileSystem.readAsStringAsync(uri, { encoding: "base64" });
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [settings, setSettings] = useState<AssistantSettings>(DEFAULT_SETTINGS);
  const [isBluetoothActive, setIsBluetoothActive] = useState(false);
  const [isRollingBufferActive, setIsRollingBufferActive] = useState(false);
  const [debugInfo, setDebugInfo] = useState("Iniciando...");

  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const statusRef = useRef<AssistantStatus>("idle");
  const isSessionActiveRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const maxRecordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef<AssistantSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const handleRemoteToggleRef = useRef<() => void>(() => {});
  useEffect(() => {
    handleRemoteToggleRef.current = () => {
      if (!isSessionActiveRef.current) {
        void startSessionFn();
      } else {
        void stopSessionFn();
      }
    };
  });

  useEffect(() => {
    void loadStoredData();
  }, []);

  useEffect(() => {
    let btCleanup: (() => void) | null = null;

    const init = async () => {
      setDebugInfo("Configurando TrackPlayer...");
      let btOk = false;
      try {
        const [tpResult] = await Promise.all([
          setupTrackPlayer(
            () => { handleRemoteToggleRef.current(); },
            () => { handleRemoteToggleRef.current(); }
          ),
          startBackgroundService(),
        ]);
        btOk = tpResult;
        setDebugInfo(btOk ? "TrackPlayer OK" : "TrackPlayer no disponible");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setDebugInfo(`Error TrackPlayer: ${msg}`);
      }
      setIsBluetoothActive(btOk);

      if (btOk) {
        const bufferStarted = await RollingBufferManager.start();
        if (bufferStarted) {
          setIsRollingBufferActive(true);
          await AsyncStorage.setItem(ROLLING_BUFFER_KEY, "true");
        }
        btCleanup = onBluetoothDisconnect(() => { void handleBluetoothDisconnect(); });
      }
    };
    void init();
    return () => {
      if (btCleanup) btCleanup();
      void destroyTrackPlayer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    startAutoPurge();
    const memoryPurge = setInterval(() => {
      const cutoff = Date.now() - 10 * 60 * 1000;
      setMessages((prev) => prev.filter((m) => m.timestamp >= cutoff));
    }, 60_000);
    return () => {
      stopAutoPurge();
      clearInterval(memoryPurge);
    };
  }, []);

  const handleBluetoothDisconnect = async () => {
    await RollingBufferManager.stop();
    setIsRollingBufferActive(false);
    await AsyncStorage.setItem(ROLLING_BUFFER_KEY, "false");
    await stopBackgroundService();
    setIsBluetoothActive(false);
  };

  const loadStoredData = async () => {
    try {
      await initDb();
      const [storedMsgs, storedSettings] = await Promise.all([
        getMessages(200),
        AsyncStorage.getItem(SETTINGS_KEY),
      ]);
      setMessages(storedMsgs);
      if (storedSettings) {
        setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(storedSettings) as Partial<AssistantSettings> });
      }
    } catch {}
  };

  const addMessages = useCallback((newMsgs: ChatMessage[]) => {
    setMessages((prev) => [...prev, ...newMsgs]);
    void Promise.all(newMsgs.map((m) => addMessage(m)));
  }, []);

  const clearMaxTimer = () => {
    if (maxRecordingTimerRef.current) {
      clearTimeout(maxRecordingTimerRef.current);
      maxRecordingTimerRef.current = null;
    }
  };

  const startListeningFn = async () => {
    if (!isSessionActiveRef.current) return;
    if (statusRef.current !== "idle") return;

    try {
      const { status: permStatus } = await Audio.requestPermissionsAsync();
      if (permStatus !== "granted") {
        Alert.alert(
          "Permiso de micrófono",
          "Para usar el asistente necesitas conceder acceso al micrófono en los ajustes.",
          [{ text: "OK" }]
        );
        await stopSessionFn();
        return;
      }

      await RollingBufferManager.pause();
      await pauseSilentTrack();

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        {
          ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
          isMeteringEnabled: true,
        },
        undefined,
        100
      );

      recordingRef.current = recording;
      setStatus("recording");

      let hasSpeech = false;
      let silenceStart: number | null = null;
      let speechStartTime: number | null = null;
      let vadTriggered = false;

      recording.setOnRecordingStatusUpdate((s) => {
        if (!isSessionActiveRef.current || vadTriggered) return;
        if (!s.isRecording) return;

        const metering = s.metering ?? -160;
        const now = Date.now();

        if (metering > VAD_SILENCE_THRESHOLD_DB) {
          if (!hasSpeech) {
            hasSpeech = true;
            speechStartTime = now;
          }
          silenceStart = null;
        } else if (hasSpeech) {
          if (!silenceStart) silenceStart = now;
          const speechDuration = speechStartTime ? now - speechStartTime : 0;
          if (
            now - silenceStart >= VAD_SILENCE_DURATION_MS &&
            speechDuration >= VAD_MIN_SPEECH_MS
          ) {
            vadTriggered = true;
            recording.setOnRecordingStatusUpdate(null);
            clearMaxTimer();
            void sendCurrentRecordingFn();
          }
        }
      });

      maxRecordingTimerRef.current = setTimeout(() => {
        if (!vadTriggered && isSessionActiveRef.current && statusRef.current === "recording") {
          vadTriggered = true;
          void sendCurrentRecordingFn();
        }
      }, MAX_RECORDING_MS);
    } catch (err) {
      console.error("[VoiceAssistant] Error starting listening:", err);
      setStatus("idle");
      await RollingBufferManager.resume();
      await resumeSilentTrack();
      if (isSessionActiveRef.current) {
        setTimeout(() => { void startListeningFn(); }, 500);
      }
    }
  };

  const sendCurrentRecordingFn = async () => {
    clearMaxTimer();
    if (statusRef.current !== "recording" || !recordingRef.current) return;
    setStatus("processing");

    try {
      const recording = recordingRef.current;
      recordingRef.current = null;
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();

      if (!uri) throw new Error("No recording URI");

      const base64Audio = await readUriAsBase64(uri);

      if (!isSessionActiveRef.current) {
        setStatus("idle");
        await RollingBufferManager.resume();
        await resumeSilentTrack();
        return;
      }

      const domain = process.env.EXPO_PUBLIC_DOMAIN;
      const apiUrl = domain
        ? `https://${domain}/api/voice/chat`
        : "http://localhost:8080/api/voice/chat";

      await purgeOldMessages();
      const currentSettings = settingsRef.current;
      const recentHistory = await getMessages(20);
      const contextText = RollingBufferManager.getContextText();

      const historyPayload: { role: string; text: string }[] = [];
      if (contextText.length > 0) {
        historyPayload.push({
          role: "user",
          text: `[Contexto ambiental]: ${contextText}`,
        });
      }
      for (const m of recentHistory) {
        if (!m.text.startsWith("[contexto]")) {
          historyPayload.push({ role: m.role, text: m.text });
        }
      }

      abortControllerRef.current = new AbortController();
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: base64Audio,
          voice: currentSettings.voice,
          language: currentSettings.language,
          history: historyPayload.slice(-20),
        }),
        signal: abortControllerRef.current.signal,
      });
      abortControllerRef.current = null;

      if (!isSessionActiveRef.current) {
        setStatus("idle");
        await RollingBufferManager.resume();
        await resumeSilentTrack();
        return;
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API ${response.status}: ${errText}`);
      }

      const data = await response.json() as VoiceApiResponse;
      const now = Date.now();
      addMessages([
        { id: generateId(), role: "user", text: data.userText, timestamp: now },
        { id: generateId(), role: "assistant", text: data.assistantText, timestamp: now + 1 },
      ]);

      if (!isSessionActiveRef.current) {
        setStatus("idle");
        await RollingBufferManager.resume();
        await resumeSilentTrack();
        return;
      }

      setStatus("speaking");
      await playResponseAudio(data.audio);

      if (isSessionActiveRef.current) {
        setStatus("idle");
        void startListeningFn();
      } else {
        setStatus("idle");
        await RollingBufferManager.resume();
        await resumeSilentTrack();
      }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (!isAbort) {
        console.error("[VoiceAssistant] Error sending recording:", err);
        const message = err instanceof Error ? err.message : "Error desconocido";
        Alert.alert("Error", `No se pudo procesar: ${message}`, [{ text: "OK" }]);
      }
      setStatus("idle");
      await RollingBufferManager.resume();
      await resumeSilentTrack();
      if (isSessionActiveRef.current && !isAbort) {
        setTimeout(() => { void startListeningFn(); }, 1000);
      }
    }
  };

  const startSessionFn = async () => {
    if (isSessionActiveRef.current) return;
    isSessionActiveRef.current = true;
    setIsSessionActive(true);
    await startListeningFn();
  };

  const stopSessionFn = async () => {
    if (!isSessionActiveRef.current) return;
    isSessionActiveRef.current = false;
    setIsSessionActive(false);

    clearMaxTimer();

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    if (recordingRef.current) {
      try {
        recordingRef.current.setOnRecordingStatusUpdate(null);
        await recordingRef.current.stopAndUnloadAsync();
      } catch {}
      recordingRef.current = null;
    }

    if (soundRef.current) {
      try { await soundRef.current.stopAsync(); } catch {}
      try { await soundRef.current.unloadAsync(); } catch {}
      soundRef.current = null;
    }

    await RollingBufferManager.resume();
    await resumeSilentTrack();
    setStatus("idle");
  };

  const playResponseAudio = async (base64Audio: string) => {
    let tmpPath = "";
    try {
      if (soundRef.current) {
        try { await soundRef.current.stopAsync(); } catch {}
        try { await soundRef.current.unloadAsync(); } catch {}
        soundRef.current = null;
      }

      // Unique filename avoids stale file conflicts between calls
      tmpPath = `${FileSystem.cacheDirectory ?? ""}ai_resp_${Date.now()}.mp3`;
      await FileSystem.writeAsStringAsync(tmpPath, base64Audio, { encoding: "base64" });

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      // Register the callback BEFORE playback starts by passing it as the 3rd
      // argument to createAsync. This prevents the race condition where
      // didJustFinish fires before setOnPlaybackStatusUpdate is called.
      let resolvePlayback!: () => void;
      const playbackDone = new Promise<void>((res) => { resolvePlayback = res; });

      const { sound } = await Audio.Sound.createAsync(
        { uri: tmpPath },
        { shouldPlay: true, volume: 1.0 },
        (ps) => {
          if (!ps.isLoaded) return;
          if (
            ps.didJustFinish ||
            (!ps.isPlaying &&
              ps.positionMillis > 0 &&
              ps.durationMillis !== undefined &&
              ps.positionMillis >= ps.durationMillis - 200)
          ) {
            resolvePlayback();
          }
        }
      );
      soundRef.current = sound;

      // Safety-net timeout: if playback status never fires, unblock after 3 min
      const safetyTimeout = new Promise<void>((res) => setTimeout(res, 3 * 60 * 1000));
      await Promise.race([playbackDone, safetyTimeout]);

      try { await sound.stopAsync(); } catch {}
      await sound.unloadAsync();
      soundRef.current = null;
    } catch (err) {
      console.error("[VoiceAssistant] Error playing audio:", err);
    } finally {
      // Clean up temp file
      if (tmpPath) {
        try { await FileSystem.deleteAsync(tmpPath, { idempotent: true }); } catch {}
      }
    }
  };

  const startSession = useCallback(async () => {
    await startSessionFn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopSession = useCallback(async () => {
    await stopSessionFn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearHistory = useCallback(() => {
    setMessages([]);
    void clearMessages();
  }, []);

  const updateSettings = useCallback((newSettings: Partial<AssistantSettings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...newSettings };
      void AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
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
