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

    const RNTP_SERVICE = "com.doublesymmetry.trackplayer.service.MusicService";
    const BG_ACTIONS_SERVICE = "com.asterinet.react.bgactions.RNBackgroundActionsTask";
    const COMBINED_FG_TYPE = "mediaPlayback|microphone";

    const findAndUpsert = (name, fgType) => {
      const idx = application.service.findIndex(
        (s) => s.$?.["android:name"] === name
      );
      const entry = {
        $: {
          "android:name": name,
          "android:exported": "true",
          "android:foregroundServiceType": fgType,
        },
      };
      if (idx >= 0) {
        application.service[idx] = entry;
      } else {
        application.service.push(entry);
      }
    };

    findAndUpsert(RNTP_SERVICE, COMBINED_FG_TYPE);
    findAndUpsert(BG_ACTIONS_SERVICE, COMBINED_FG_TYPE);

    return cfg;
  });

  return config;
}

module.exports = withReactNativeTrackPlayer;
