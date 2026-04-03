import AsyncStorage from "@react-native-async-storage/async-storage";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type AssistantStatus = "idle" | "recording" | "processing" | "speaking";

/** Shape of the /api/voice/chat response from the backend. */
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

const DEFAULT_SETTINGS: AssistantSettings = { voice: "nova" };

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [settings, setSettings] = useState<AssistantSettings>(DEFAULT_SETTINGS);
  const [isBluetoothActive] = useState(false);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    void loadStoredData();
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
      // Silently ignore storage errors — app still functions without persisted data
    }
  };

  const saveMessages = async (msgs: ChatMessage[]) => {
    try {
      await AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(msgs.slice(-50)));
    } catch {
      // Non-critical: history just won't persist across sessions
    }
  };

  const addMessages = useCallback((newMsgs: ChatMessage[]) => {
    setMessages((prev) => {
      const updated = [...prev, ...newMsgs];
      void saveMessages(updated);
      return updated;
    });
  }, []);

  const startRecording = useCallback(async () => {
    if (status !== "idle") return;
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
  }, [status]);

  const stopRecording = useCallback(async () => {
    if (status !== "recording" || !recordingRef.current) return;
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

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: base64Audio, voice: settings.voice }),
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
  }, [status, settings.voice, addMessages]);

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
