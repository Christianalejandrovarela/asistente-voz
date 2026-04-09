/**
 * withBluetoothSco.js — Expo Config Plugin
 *
 * Writes BluetoothScoModule.kt + BluetoothScoPackage.kt into the Android
 * source tree and patches MainApplication.kt to register the package.
 *
 * The Kotlin module exposes two ReactMethods:
 *   startSco()  – sets MODE_IN_COMMUNICATION, starts BT SCO, registers
 *                 BroadcastReceiver for ACTION_SCO_AUDIO_STATE_UPDATED,
 *                 emits "BTScoConnected" / "BTScoDisconnected" to JS.
 *   stopSco()   – tears down SCO, unregisters receiver, resets audio mode.
 *
 * JS waits for "BTScoConnected" via NativeEventEmitter before starting the
 * microphone — guaranteeing audio is routed through the BT headset.
 */

const { withDangerousMod, withAndroidManifest } = require("@expo/config-plugins");
const fs   = require("fs");
const path = require("path");

// ─── Kotlin source ────────────────────────────────────────────────────────────

function makeModuleKt(pkg) {
  return `package ${pkg}

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.net.wifi.WifiManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

class BluetoothScoModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val audioManager =
        reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val wifiManager =
        reactContext.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    private var scoReceiver: BroadcastReceiver? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun getName(): String = "BluetoothScoModule"

    private fun emit(event: String) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(event, null)
    }

    @ReactMethod
    fun startSco(promise: Promise) {
        try {
            // Tear down any previous receiver first.
            scoReceiver?.let {
                try { reactApplicationContext.unregisterReceiver(it) } catch (_: Exception) {}
            }

            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context, intent: Intent) {
                    val state = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1)
                    when (state) {
                        AudioManager.SCO_AUDIO_STATE_CONNECTED    -> emit("BTScoConnected")
                        AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> emit("BTScoDisconnected")
                    }
                }
            }
            scoReceiver = receiver
            reactApplicationContext.registerReceiver(
                receiver,
                IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
            )

            // VoIP mode gives call-level OS audio priority.
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            audioManager.startBluetoothSco()
            @Suppress("DEPRECATION")
            audioManager.isBluetoothScoOn = true

            // Wi-Fi lock prevents the radio from sleeping during streaming.
            wifiLock?.release()
            wifiLock = wifiManager
                .createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "AsistenteVozWifi")
                .also { it.acquire() }

            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SCO_START_ERR", e.message, e)
        }
    }

    @ReactMethod
    fun stopSco(promise: Promise) {
        try {
            scoReceiver?.let {
                try { reactApplicationContext.unregisterReceiver(it) } catch (_: Exception) {}
            }
            scoReceiver = null

            audioManager.stopBluetoothSco()
            @Suppress("DEPRECATION")
            audioManager.isBluetoothScoOn = false
            audioManager.mode = AudioManager.MODE_NORMAL

            wifiLock?.release()
            wifiLock = null

            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SCO_STOP_ERR", e.message, e)
        }
    }

    // Required for NativeEventEmitter on React Native's new bridge.
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
`;
}

function makePackageKt(pkg) {
  return `package ${pkg}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class BluetoothScoPackage : ReactPackage {
    override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
        listOf(BluetoothScoModule(ctx))

    override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
`;
}

// ─── Config plugin ────────────────────────────────────────────────────────────

module.exports = function withBluetoothSco(config) {
  // Step 1: write Kotlin source files.
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const pkg    = cfg.android?.package ?? "com.example.app";
      const pkgDir = pkg.replace(/\./g, "/");
      const srcDir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app/src/main/java",
        pkgDir
      );
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, "BluetoothScoModule.kt"),
        makeModuleKt(pkg)
      );
      fs.writeFileSync(
        path.join(srcDir, "BluetoothScoPackage.kt"),
        makePackageKt(pkg)
      );

      // Patch MainApplication.kt to register BluetoothScoPackage.
      const mainAppPath = path.join(srcDir, "MainApplication.kt");
      if (fs.existsSync(mainAppPath)) {
        let src = fs.readFileSync(mainAppPath, "utf8");

        const marker    = "add(BluetoothScoPackage())";
        const addLine   = "\n        add(BluetoothScoPackage())";

        if (!src.includes(marker)) {
          // Try to inject after PackageList block.
          src = src.replace(
            /PackageList\(this\)\.packages/,
            `PackageList(this).packages.also { pkgs ->${addLine}\n        }`
          );
          // Fallback: inject inside getPackages return if above didn't match.
          if (!src.includes(marker)) {
            src = src.replace(
              /PackageList\(this\)\.packages\.apply\s*\{/,
              `PackageList(this).packages.apply {\n        add(BluetoothScoPackage())`
            );
          }
          fs.writeFileSync(mainAppPath, src);
        }
      }

      return cfg;
    },
  ]);

  // Step 2: add Android permissions.
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    if (!manifest["uses-permission"]) manifest["uses-permission"] = [];

    const needed = [
      "android.permission.BLUETOOTH",
      "android.permission.BLUETOOTH_CONNECT",
      "android.permission.MODIFY_AUDIO_SETTINGS",
      "android.permission.ACCESS_WIFI_STATE",
      "android.permission.CHANGE_WIFI_STATE",
    ];
    const existing = new Set(
      manifest["uses-permission"].map((p) => p.$?.["android:name"])
    );
    for (const perm of needed) {
      if (!existing.has(perm)) {
        manifest["uses-permission"].push({ $: { "android:name": perm } });
      }
    }
    return cfg;
  });

  return config;
};
