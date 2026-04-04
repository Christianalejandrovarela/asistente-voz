// Resolve @expo/config-plugins with fallback — works in monorepo (via root
// node_modules) and in EAS cloud (where expo re-exports config-plugins).
const { withAndroidManifest, withInfoPlist } = (() => {
  try { return require("@expo/config-plugins"); } catch (_) {}
  try { return require("expo/config-plugins"); } catch (_) {}
  throw new Error("Cannot resolve @expo/config-plugins. Add it as a devDependency.");
})();

/**
 * Expo config plugin for react-native-track-player.
 *
 * Configures:
 * - iOS: Ensures "audio" is in UIBackgroundModes for background audio playback
 *   (also handled by expo-av; this plugin makes the intent explicit).
 * - Android: Declares the KotlinAudioEngine foreground service with
 *   `android:foregroundServiceType="mediaPlayback"`, required for Android 10+
 *   to show the media notification and allow background playback.
 */
function withReactNativeTrackPlayer(config) {
  config = withInfoPlist(config, (cfg) => {
    const modes = cfg.modResults.UIBackgroundModes ?? [];
    if (!modes.includes("audio")) {
      cfg.modResults.UIBackgroundModes = [...modes, "audio"];
    }
    return cfg;
  });

  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) return cfg;

    if (!application.service) application.service = [];

    const RNTP_SERVICE = "com.doublesymmetry.kotlinaudio.service.KotlinAudioEngine";
    const already = application.service.some(
      (s) => s.$?.["android:name"] === RNTP_SERVICE
    );

    if (!already) {
      application.service.push({
        $: {
          "android:name": RNTP_SERVICE,
          "android:exported": "false",
          "android:foregroundServiceType": "mediaPlayback",
        },
      });
    }

    return cfg;
  });

  return config;
}

module.exports = withReactNativeTrackPlayer;
