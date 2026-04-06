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
     * RNTP v4 service class name.
     * react-native-background-actions v4 service class name.
     *
     * Both need foregroundServiceType="mediaPlayback|microphone" so Android 10+
     * permits audio capture + playback from a foreground service when the screen
     * is off.  android:stopWithTask="false" keeps the services alive when the
     * task is removed from the recents list.
     *
     * We deliberately do NOT touch android:exported here — we let each library's
     * own manifest declare that value to avoid Gradle manifest-merger conflicts.
     */
    const RNTP_SERVICE       = "com.doublesymmetry.trackplayer.service.MusicService";
    const BG_ACTIONS_SERVICE = "com.asterinet.react.bgactions.RNBackgroundActionsTask";
    const COMBINED_FG_TYPE   = "mediaPlayback|microphone";

    /**
     * Merge ONLY foregroundServiceType and stopWithTask into an existing
     * service entry, preserving ALL other attributes (including exported,
     * intent-filters, etc.) set by the library's own config plugin.
     * If no entry exists yet we create a minimal stub — the library's plugin
     * will merge its own attributes later.
     */
    const upsertServiceAttrs = (name, fgType) => {
      const idx = application.service.findIndex(
        (s) => s.$?.["android:name"] === name
      );
      if (idx >= 0) {
        // Merge into existing entry — keep everything the library already set.
        application.service[idx].$ = {
          ...application.service[idx].$,
          "android:foregroundServiceType": fgType,
          "android:stopWithTask": "false",
        };
      } else {
        // Stub entry — no android:exported so the library manifest wins at merge time.
        application.service.push({
          $: {
            "android:name": name,
            "android:foregroundServiceType": fgType,
            "android:stopWithTask": "false",
          },
        });
      }
    };

    upsertServiceAttrs(RNTP_SERVICE, COMBINED_FG_TYPE);
    upsertServiceAttrs(BG_ACTIONS_SERVICE, COMBINED_FG_TYPE);

    /**
     * Ensure the battery-optimization exemption permission is present
     * (system permission — silently ignored on devices below Android 6).
     */
    if (!manifest.manifest["uses-permission"]) manifest.manifest["uses-permission"] = [];
    const BATT_PERM = "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS";
    const hasBattPerm = manifest.manifest["uses-permission"].some(
      (p) => p.$?.["android:name"] === BATT_PERM
    );
    if (!hasBattPerm) {
      manifest.manifest["uses-permission"].push({ $: { "android:name": BATT_PERM } });
    }

    return cfg;
  });

  return config;
}

module.exports = withReactNativeTrackPlayer;
