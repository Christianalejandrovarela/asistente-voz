/**
 * remoteLogger.ts
 *
 * Remote logging over HTTP.  Every call is fire-and-forget: no await, no
 * error propagation, zero impact on the voice loop latency.
 *
 * Usage:
 *   import { rlog, rwarn, rerror } from '@/services/remoteLogger';
 *   rlog('MIC', 'createAsync() start');
 *   rerror('MIC', 'createAsync() threw: ' + err.message);
 *
 * Initialization (call once at app start in index.native.ts):
 *   import { initRemoteLogger } from '@/services/remoteLogger';
 *   initRemoteLogger();
 *
 * The init also intercepts console.log/warn/error output that carries one of
 * the known prefixes ([VoiceLoop], [PlaybackService], [RollingBuffer]) and
 * forwards those lines automatically so you see them in the Replit server log
 * without having to instrument every single callsite.
 */

import { Platform } from "react-native";

// ─── Config ───────────────────────────────────────────────────────────────────

const LOG_ENDPOINT = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api/remote-log`
  : null;

// Only forward console lines that include these prefixes (avoids flooding the
// server with Expo/React Native internals).
const FORWARD_PREFIXES = [
  "[VoiceLoop]",
  "[PlaybackService]",
  "[RollingBuffer]",
  "[RemoteLogger]",
];

// ─── Internal send (fire-and-forget) ──────────────────────────────────────────

function send(level: "LOG" | "WARN" | "ERROR", tag: string, message: string): void {
  if (!LOG_ENDPOINT || Platform.OS === "web") return;

  // Truncate very long messages so we don't accidentally POST megabytes
  const body = JSON.stringify({
    level,
    tag,
    message: message.slice(0, 1000),
    ts: Date.now(),
  });

  fetch(LOG_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }).catch(() => {
    // Intentionally swallowed — the logger must never crash the app
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function rlog(tag: string, message: string): void {
  send("LOG", tag, message);
}

export function rwarn(tag: string, message: string): void {
  send("WARN", tag, message);
}

export function rerror(tag: string, message: string): void {
  send("ERROR", tag, message);
}

// ─── Console intercept ────────────────────────────────────────────────────────

let _initialized = false;

/**
 * Call once at app startup. Patches console.log/warn/error to forward lines
 * that contain known service prefixes to the remote log endpoint.
 * Does nothing on web.
 */
export function initRemoteLogger(): void {
  if (_initialized || Platform.OS === "web") return;
  _initialized = true;

  const origLog   = console.log.bind(console);
  const origWarn  = console.warn.bind(console);
  const origError = console.error.bind(console);

  const stringify = (args: unknown[]): string =>
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

  const shouldForward = (msg: string): boolean =>
    FORWARD_PREFIXES.some((p) => msg.includes(p));

  console.log = (...args: unknown[]) => {
    origLog(...args);
    const msg = stringify(args);
    if (shouldForward(msg)) send("LOG", "console", msg);
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    const msg = stringify(args);
    if (shouldForward(msg)) send("WARN", "console", msg);
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    const msg = stringify(args);
    // Always forward errors regardless of prefix
    send("ERROR", "console", msg);
  };

  // Announce initialization
  send("LOG", "RemoteLogger", `[RemoteLogger] initialized — endpoint: ${LOG_ENDPOINT ?? "NONE (no domain)"}`);
}
