import * as SQLite from "expo-sqlite";

import type { ChatMessage } from "@/context/AssistantContext";

let db: SQLite.SQLiteDatabase | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!db) {
    db = await SQLite.openDatabaseAsync("conversation.db");
  }
  return db;
}

export async function initDb(): Promise<void> {
  const database = await getDb();
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  `);
}

export async function getMessages(limit = 50): Promise<ChatMessage[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<ChatMessage>(
    "SELECT id, role, text, timestamp FROM messages ORDER BY timestamp DESC LIMIT ?",
    [limit]
  );
  return rows.reverse();
}

export async function addMessage(message: ChatMessage): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    "INSERT OR REPLACE INTO messages (id, role, text, timestamp) VALUES (?, ?, ?, ?)",
    [message.id, message.role, message.text, message.timestamp]
  );
}

export async function clearMessages(): Promise<void> {
  const database = await getDb();
  await database.runAsync("DELETE FROM messages");
}
