/**
 * DEPRECATED — kept only to avoid breaking any legacy imports.
 *
 * TrackPlayer.registerPlaybackService() is now called in index.native.ts
 * (the global entry point) BEFORE Expo Router mounts any React component.
 * Doing it here would be a no-op at best and a duplicate registration at worst.
 */
console.log("[initTrackPlayer] Registration is handled in index.native.ts — no-op here.");
