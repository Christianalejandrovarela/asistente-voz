import AsyncStorage from "@react-native-async-storage/async-storage";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { setupTrackPlayer, destroyTrackPlayer } from "@/services/trackPlayer";
import { startBackgroundService } from "@/services/backgroundService";

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

interface AssistantContextValue {
  status: AssistantStatus;
  messages: ChatMessage[];
  settings: AssistantSettings;
  isBluetoothActive: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  clearHistory: () => void;
  updateSettings: (settings: Partial<AssistantSettings>) => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

const MESSAGES_KEY = "@voice_assistant_messages";
const SETTINGS_KEY = "@voice_assistant_settings";

const DEFAULT_SETTINGS: AssistantSettings = { voice: "nova", language: "es" };

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [settings, setSettings] = useState<AssistantSettings>(DEFAULT_SETTINGS);
  const [isBluetoothActive, setIsBluetoothActive] = useState(false);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const statusRef = useRef<AssistantStatus>("idle");

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    void loadStoredData();
  }, []);

  /**
   * Bluetooth listener setup lives at the provider level so it remains active
   * for the full app lifetime — even when the main screen is unmounted or the
   * app moves to the background (JS thread stays alive via the audio session
   * and the background foreground-service).
   *
   * A stable ref is used so the callback always reads the latest status
   * without re-registering listeners when status changes.
   */
  const handleRemoteToggleRef = useRef<() => void>(() => {});
  useEffect(() => {
    handleRemoteToggleRef.current = () => {
      const s = statusRef.current;
      if (s === "idle") void startRecordingFn();
      else if (s === "recording") void stopRecordingFn();
    };
  });

  useEffect(() => {
    const init = async () => {
      const [btOk] = await Promise.all([
        setupTrackPlayer(
          () => handleRemoteToggleRef.current(),
          () => handleRemoteToggleRef.current()
        ),
        startBackgroundService(),
      ]);
      setIsBluetoothActive(btOk);
    };
    void init();
    return () => {
      void destroyTrackPlayer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadStoredData = async () => {
    try {
      const [storedMessages, storedSettings] = await Promise.all([
        AsyncStorage.getItem(MESSAGES_KEY),
        AsyncStorage.getItem(SETTINGS_KEY),
      ]);
      if (storedMessages) setMessages(JSON.parse(storedMessages) as ChatMessage[]);
      if (storedSettings) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(storedSettings) as Partial<AssistantSettings> });
    } catch {
      // Silently ignore — app still functions without persisted data.
    }
  };

  const saveMessages = async (msgs: ChatMessage[]) => {
    try {
      await AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(msgs.slice(-50)));
    } catch {}
  };

  const addMessages = useCallback((newMsgs: ChatMessage[]) => {
    setMessages((prev) => {
      const updated = [...prev, ...newMsgs];
      void saveMessages(updated);
      return updated;
    });
  }, []);

  const startRecordingFn = async () => {
    if (statusRef.current !== "idle") return;
    try {
      const { status: permStatus } = await Audio.requestPermissionsAsync();
      if (permStatus !== "granted") return;

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;
      setStatus("recording");
    } catch (err) {
      console.error("Error starting recording:", err);
      setStatus("idle");
    }
  };

  const stopRecordingFn = async () => {
    if (statusRef.current !== "recording" || !recordingRef.current) return;
    setStatus("processing");

    try {
      const recording = recordingRef.current;
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      recordingRef.current = null;

      if (!uri) throw new Error("No recording URI available");

      const base64Audio = await FileSystem.readAsStringAsync(uri, {
        encoding: "base64",
      });

      const domain = process.env.EXPO_PUBLIC_DOMAIN;
      const apiUrl = domain
        ? `https://${domain}/api/voice/chat`
        : "http://localhost:8080/api/voice/chat";

      const currentSettings = settings;
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: base64Audio,
          voice: currentSettings.voice,
          language: currentSettings.language,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API error ${response.status}: ${errText}`);
      }

      const data = await response.json() as VoiceApiResponse;

      const now = Date.now();
      addMessages([
        { id: generateId(), role: "user", text: data.userText, timestamp: now },
        { id: generateId(), role: "assistant", text: data.assistantText, timestamp: now + 1 },
      ]);

      setStatus("speaking");
      await playResponseAudio(data.audio);
      setStatus("idle");
    } catch (err) {
      console.error("Error processing voice:", err);
      setStatus("idle");
    }
  };

  const startRecording = useCallback(async () => {
    await startRecordingFn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopRecording = useCallback(async () => {
    await stopRecordingFn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const playResponseAudio = async (base64Audio: string) => {
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }

      const tmpPath = `${FileSystem.cacheDirectory}ai_resp_${Date.now()}.mp3`;
      await FileSystem.writeAsStringAsync(tmpPath, base64Audio, {
        encoding: "base64",
      });

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
      });

      const { sound } = await Audio.Sound.createAsync({ uri: tmpPath });
      soundRef.current = sound;

      await new Promise<void>((resolve) => {
        sound.setOnPlaybackStatusUpdate((playStatus) => {
          if (playStatus.isLoaded && playStatus.didJustFinish) resolve();
        });
        void sound.playAsync();
      });

      await sound.unloadAsync();
      soundRef.current = null;
    } catch (err) {
      console.error("Error playing audio response:", err);
    }
  };

  const clearHistory = useCallback(() => {
    setMessages([]);
    void AsyncStorage.removeItem(MESSAGES_KEY);
  }, []);

  const updateSettings = useCallback((newSettings: Partial<AssistantSettings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...newSettings };
      void AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  return (
    <AssistantContext.Provider
      value={{
        status,
        messages,
        settings,
        isBluetoothActive,
        startRecording,
        stopRecording,
        clearHistory,
        updateSettings,
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
