const { withAndroidManifest, withInfoPlist } = (() => {
  try { return require("@expo/config-plugins"); } catch (_) {}
  try { return require("expo/config-plugins"); } catch (_) {}
  throw new Error("Cannot resolve @expo/config-plugins. Add it as a devDependency.");
})();

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

    /**
     * RNTP v4 service class.
     * react-native-background-actions v4 service class.
     * Both services need foregroundServiceType="mediaPlayback|microphone" so
     * Android 10+ allows audio capture + playback from a foreground service
     * even when the screen is off.
     */
    const RNTP_SERVICE       = "com.doublesymmetry.trackplayer.service.MusicService";
    const BG_ACTIONS_SERVICE = "com.asterinet.react.bgactions.RNBackgroundActionsTask";
    const COMBINED_FG_TYPE   = "mediaPlayback|microphone";

    /**
     * Merge the foregroundServiceType and stopWithTask attrs into an
     * existing service entry, preserving intent-filters and other attrs
     * already set by the library's own plugin.  If the entry does not exist
     * yet we create a minimal one so the attribute is present at compile time.
     */
    const upsertServiceAttrs = (name, fgType) => {
      const idx = application.service.findIndex(
        (s) => s.$?.["android:name"] === name
      );
      if (idx >= 0) {
        application.service[idx].$ = {
          ...application.service[idx].$,
          "android:foregroundServiceType": fgType,
          "android:stopWithTask": "false",
        };
      } else {
        application.service.push({
          $: {
            "android:name": name,
            "android:exported": "false",
            "android:foregroundServiceType": fgType,
            "android:stopWithTask": "false",
          },
        });
      }
    };

    upsertServiceAttrs(RNTP_SERVICE, COMBINED_FG_TYPE);
    upsertServiceAttrs(BG_ACTIONS_SERVICE, COMBINED_FG_TYPE);

    /**
     * Ensure the battery optimization exemption permission is present
     * (system permission — ignored on devices below Android 6).
     */
    const permissions = manifest.manifest["uses-permission"] ?? [];
    const BATT_PERM = "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS";
    const hasBattPerm = permissions.some(
      (p) => p.$?.["android:name"] === BATT_PERM
    );
    if (!hasBattPerm) {
      if (!manifest.manifest["uses-permission"]) manifest.manifest["uses-permission"] = [];
      manifest.manifest["uses-permission"].push({ $: { "android:name": BATT_PERM } });
    }

    return cfg;
  });

  return config;
}

module.exports = withReactNativeTrackPlayer;
