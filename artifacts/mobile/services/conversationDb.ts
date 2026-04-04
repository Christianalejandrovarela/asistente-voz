import AsyncStorage from "@react-native-async-storage/async-storage";

import type { ChatMessage } from "@/context/AssistantContext";

const MESSAGES_KEY = "@voice_assistant_messages_v2";
const BUFFER_WINDOW_MS = 10 * 60 * 1000;

export async function initDb(): Promise<void> {
  await purgeOldMessages();
}

export async function getMessages(limit = 50): Promise<ChatMessage[]> {
  await purgeOldMessages();
  try {
    const raw = await AsyncStorage.getItem(MESSAGES_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as ChatMessage[];
    return all.slice(-limit);
  } catch {
    return [];
  }
}

export async function addMessage(message: ChatMessage): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(MESSAGES_KEY);
    const all: ChatMessage[] = raw ? (JSON.parse(raw) as ChatMessage[]) : [];
    all.push(message);
    await AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(all.slice(-500)));
  } catch {}
}

export async function clearMessages(): Promise<void> {
  try {
    await AsyncStorage.removeItem(MESSAGES_KEY);
  } catch {}
}

export async function purgeOldMessages(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(MESSAGES_KEY);
    if (!raw) return 0;
    const all = JSON.parse(raw) as ChatMessage[];
    const cutoff = Date.now() - BUFFER_WINDOW_MS;
    const filtered = all.filter((m) => m.timestamp >= cutoff);
    const removed = all.length - filtered.length;
    if (removed > 0) {
      await AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(filtered));
    }
    return removed;
  } catch {
    return 0;
  }
}

let purgeInterval: ReturnType<typeof setInterval> | null = null;

export function startAutoPurge(): void {
  if (purgeInterval) return;
  purgeInterval = setInterval(() => {
    void purgeOldMessages();
  }, 60_000);
}

export function stopAutoPurge(): void {
  if (purgeInterval) {
    clearInterval(purgeInterval);
    purgeInterval = null;
  }
}
