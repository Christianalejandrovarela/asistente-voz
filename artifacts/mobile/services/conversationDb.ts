import AsyncStorage from "@react-native-async-storage/async-storage";

import type { ChatMessage } from "@/context/AssistantContext";

const MESSAGES_KEY = "@voice_assistant_messages_v2";

export async function initDb(): Promise<void> {
}

export async function getMessages(limit = 50): Promise<ChatMessage[]> {
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
