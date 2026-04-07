/**
 * userProfileService.ts — Long-term Memory (Persistent User Profile)
 *
 * Stores the user profile in AsyncStorage (same as the rest of the app).
 * AsyncStorage is async, non-blocking, works in both the main JS context
 * and the RNTP PlaybackService headless context, and handles missing
 * keys gracefully — no file path or File I/O issues on Android.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
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

// ─── Storage key ─────────────────────────────────────────────────────────────

const PROFILE_KEY = "@user_profile_v1";

const DEFAULT_PROFILE: UserProfile = {
  interests: [],
  facts: [],
  lastUpdated: new Date().toISOString(),
};

// ─── In-memory cache (avoid async storage read on every API call) ─────────────

let _cache: UserProfile | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load the user profile from AsyncStorage.
 * Returns the default empty profile if none has been saved yet.
 * Never throws — all errors are swallowed and return the safe default.
 */
export async function getUserProfile(): Promise<UserProfile> {
  if (_cache) return _cache;
  try {
    const json = await AsyncStorage.getItem(PROFILE_KEY);
    if (json) {
      _cache = JSON.parse(json) as UserProfile;
      rlog("PROFILE", `loaded — name=${_cache.name ?? "(none)"} facts=${_cache.facts.length}`);
    } else {
      _cache = { ...DEFAULT_PROFILE };
    }
    return _cache;
  } catch (e) {
    rwarn("PROFILE", `getUserProfile failed (returning default): ${e instanceof Error ? e.message : String(e)}`);
    _cache = { ...DEFAULT_PROFILE };
    return _cache;
  }
}

/**
 * Persist the user profile to AsyncStorage.
 * Updates the in-memory cache immediately.
 * Never throws — write errors are logged and swallowed.
 */
export async function saveUserProfile(profile: UserProfile): Promise<void> {
  profile.lastUpdated = new Date().toISOString();
  _cache = profile;
  try {
    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    rlog("PROFILE", `saved — name=${profile.name ?? "(none)"} interests=${profile.interests.length} facts=${profile.facts.length}`);
  } catch (e) {
    rwarn("PROFILE", `saveUserProfile failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Apply an array of ProfileUpdate diffs returned by the server after each
 * conversation turn. Deduplicates lists and caps their sizes.
 * Returns true if any change was actually applied.
 */
export async function applyProfileUpdates(updates: ProfileUpdate[]): Promise<boolean> {
  if (!updates?.length) return false;
  try {
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
  } catch (e) {
    rwarn("PROFILE", `applyProfileUpdates failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Format the profile as a compact string suitable for injection into
 * the AI system prompt. Returns empty string if the profile has no data.
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
