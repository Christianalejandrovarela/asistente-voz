/**
 * userProfileService.ts — Long-term Memory (Persistent User Profile)
 *
 * Stores a structured user profile on the device as user_profile.json inside
 * the app's document directory (survives app restarts, app updates, etc.).
 * The profile is injected into every API request so the AI always knows who
 * the user is without needing to re-read old conversation history.
 *
 * Profile extraction (new facts → profile) is handled server-side and the
 * result comes back as ProfileUpdate[] in the /api/voice/chat response.
 */

import * as FileSystem from "expo-file-system/legacy";
import { rlog, rwarn } from "./remoteLogger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserProfile {
  name?: string;
  age?: number;
  location?: string;
  occupation?: string;
  interests: string[];
  facts: string[];
  lastUpdated: string;
}

export interface ProfileUpdate {
  field: "name" | "age" | "location" | "occupation" | "interest" | "fact";
  value: string;
}

// ─── Storage path ─────────────────────────────────────────────────────────────

const PROFILE_PATH = `${FileSystem.documentDirectory ?? ""}user_profile.json`;

const DEFAULT_PROFILE: UserProfile = {
  interests: [],
  facts: [],
  lastUpdated: new Date().toISOString(),
};

// ─── In-memory cache (avoid re-reading the file on every API call) ────────────

let _cache: UserProfile | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getUserProfile(): Promise<UserProfile> {
  if (_cache) return _cache;
  try {
    const json = await FileSystem.readAsStringAsync(PROFILE_PATH);
    _cache = JSON.parse(json) as UserProfile;
    rlog("PROFILE", `loaded profile — name=${_cache.name ?? "(none)"} facts=${_cache.facts.length}`);
    return _cache;
  } catch {
    _cache = { ...DEFAULT_PROFILE };
    return _cache;
  }
}

export async function saveUserProfile(profile: UserProfile): Promise<void> {
  profile.lastUpdated = new Date().toISOString();
  _cache = profile;
  try {
    await FileSystem.writeAsStringAsync(PROFILE_PATH, JSON.stringify(profile, null, 2));
    rlog("PROFILE", `saved — name=${profile.name ?? "(none)"} interests=${profile.interests.length} facts=${profile.facts.length}`);
  } catch (e) {
    rwarn("PROFILE", `saveUserProfile failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Apply an array of ProfileUpdate diffs returned by the server.
 * Deduplicates interests/facts. Caps lists at 25 items each.
 * Returns true if any change was applied.
 */
export async function applyProfileUpdates(updates: ProfileUpdate[]): Promise<boolean> {
  if (!updates?.length) return false;
  const profile = await getUserProfile();
  let changed = false;

  for (const u of updates) {
    const val = u.value?.trim();
    if (!val) continue;

    if (u.field === "name") {
      if (profile.name !== val) { profile.name = val; changed = true; }
    } else if (u.field === "age") {
      const n = parseInt(val, 10);
      if (!isNaN(n) && profile.age !== n) { profile.age = n; changed = true; }
    } else if (u.field === "location") {
      if (profile.location !== val) { profile.location = val; changed = true; }
    } else if (u.field === "occupation") {
      if (profile.occupation !== val) { profile.occupation = val; changed = true; }
    } else if (u.field === "interest") {
      if (!profile.interests.includes(val)) {
        profile.interests.push(val);
        if (profile.interests.length > 25) profile.interests = profile.interests.slice(-25);
        changed = true;
      }
    } else if (u.field === "fact") {
      if (!profile.facts.includes(val)) {
        profile.facts.push(val);
        if (profile.facts.length > 30) profile.facts = profile.facts.slice(-30);
        changed = true;
      }
    }
  }

  if (changed) {
    await saveUserProfile(profile);
    rlog("PROFILE", `updated: ${updates.map(u => `${u.field}="${u.value}"`).join(", ")}`);
  }
  return changed;
}

/**
 * Format the profile as a compact string for the system prompt.
 * Returns empty string if profile has no meaningful data yet.
 */
export function formatProfileForPrompt(profile: UserProfile): string {
  const lines: string[] = [];
  if (profile.name)       lines.push(`Nombre: ${profile.name}`);
  if (profile.age)        lines.push(`Edad: ${profile.age}`);
  if (profile.location)   lines.push(`Ubicación: ${profile.location}`);
  if (profile.occupation) lines.push(`Trabajo: ${profile.occupation}`);
  if (profile.interests.length)
    lines.push(`Intereses: ${profile.interests.slice(-10).join(", ")}`);
  if (profile.facts.length)
    lines.push(`Información adicional:\n${profile.facts.slice(-15).map(f => `- ${f}`).join("\n")}`);
  return lines.join("\n");
}
