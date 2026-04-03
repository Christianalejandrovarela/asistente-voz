/**
 * Web / Expo Go stub for Bluetooth headphone controls.
 * Bluetooth controls via react-native-track-player require a native EAS build.
 * This stub is loaded by Metro on the web platform instead.
 */

export async function setupTrackPlayer(
  _onPlay: () => void,
  _onPause: () => void
): Promise<boolean> {
  return false;
}

export async function destroyTrackPlayer(): Promise<void> {}
