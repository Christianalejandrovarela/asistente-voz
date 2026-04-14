/**
 * withVolumeKeys.js — Expo Config Plugin
 *
 * Creates VolumeKeyModule.kt + VolumeKeyPackage.kt and patches MainActivity.kt
 * to override dispatchKeyEvent, intercepting VOLUME_UP / VOLUME_DOWN key events.
 *
 * When a volume key is pressed, the native side emits "VolumeKeyPressed" to JS
 * via DeviceEventManagerModule. The key event is NOT consumed (super is called),
 * so Android's normal volume controls continue to work — the JS side simply gets
 * notified so it can dismiss the AMOLED "Modo Bolsillo" overlay.
 */

const { withDangerousMod } = require("@expo/config-plugins");
const fs   = require("fs");
const path = require("path");

// ── VolumeKeyModule.kt ────────────────────────────────────────────────────────
// A minimal NativeModule that MainActivity can call via a companion-object
// static reference.  MainActivity is in the same package so no fully-qualified
// import is needed.

function makeModuleKt(pkg) {
  return `package ${pkg}

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

class VolumeKeyModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        /** Set by init{}; lets MainActivity call notifyVolumeKey() statically. */
        @Volatile var instance: VolumeKeyModule? = null

        /** Called from MainActivity.dispatchKeyEvent — safe to call before React is ready. */
        fun notifyVolumeKey() {
            instance?.emitVolumeKey()
        }
    }

    init { instance = this }

    override fun getName(): String = "VolumeKeyModule"

    fun emitVolumeKey() {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("VolumeKeyPressed", null)
        } catch (_: Exception) {}
    }

    // Required boilerplate for NativeEventEmitter on RN new bridge.
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
`;
}

// ── VolumeKeyPackage.kt ───────────────────────────────────────────────────────

function makePackageKt(pkg) {
  return `package ${pkg}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class VolumeKeyPackage : ReactPackage {
    override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
        listOf(VolumeKeyModule(ctx))

    override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
`;
}

// ── MainApplication.kt patch ─────────────────────────────────────────────────
// Registers VolumeKeyPackage using the same three-strategy approach as
// withBluetoothSco.js (handles different Expo / RN template variants).

function patchMainApplication(src) {
  if (src.includes("VolumeKeyPackage()")) return src;

  const p1 = src.replace(
    /PackageList\(this\)\.packages(?!\.apply)/,
    "PackageList(this).packages.apply { add(VolumeKeyPackage()) }"
  );
  if (p1.includes("VolumeKeyPackage()")) return p1;

  const p2 = src.replace(
    /(val packages = PackageList\(this\)\.packages\s*\n)/,
    "$1          packages.add(VolumeKeyPackage())\n"
  );
  if (p2.includes("VolumeKeyPackage()")) return p2;

  return src.replace(
    /(\n\s*return packages)/,
    "\n          packages.add(VolumeKeyPackage())$1"
  );
}

// ── MainActivity.kt patch ─────────────────────────────────────────────────────
// Override dispatchKeyEvent to notify VolumeKeyModule when a volume key is
// pressed.  Returns super.dispatchKeyEvent(event) so Android still handles the
// volume change normally — we only piggyback on the event, never consume it.

function patchMainActivity(src) {
  if (src.includes("KEYCODE_VOLUME_UP")) return src; // already patched

  // Add KeyEvent import after the last existing import line.
  if (!src.includes("import android.view.KeyEvent")) {
    // Find the position right after the last "import" statement line.
    const lines   = src.split("\n");
    let lastImport = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith("import ")) lastImport = i;
    }
    if (lastImport >= 0) {
      lines.splice(lastImport + 1, 0, "import android.view.KeyEvent");
      src = lines.join("\n");
    }
  }

  // Inject dispatchKeyEvent override before the very last closing brace of the file.
  const override = `
    override fun dispatchKeyEvent(event: KeyEvent?): Boolean {
        if (event != null && event.action == KeyEvent.ACTION_DOWN) {
            val kc = event.keyCode
            if (kc == KeyEvent.KEYCODE_VOLUME_UP || kc == KeyEvent.KEYCODE_VOLUME_DOWN) {
                VolumeKeyModule.notifyVolumeKey()
            }
        }
        return super.dispatchKeyEvent(event)
    }`;

  const lastBrace = src.lastIndexOf("}");
  if (lastBrace === -1) return src;
  return src.slice(0, lastBrace) + override + "\n" + src.slice(lastBrace);
}

// ── Expo Config Plugin ────────────────────────────────────────────────────────

module.exports = function withVolumeKeys(config) {
  return withDangerousMod(config, [
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

      // Write Kotlin source files.
      fs.writeFileSync(path.join(srcDir, "VolumeKeyModule.kt"),  makeModuleKt(pkg));
      fs.writeFileSync(path.join(srcDir, "VolumeKeyPackage.kt"), makePackageKt(pkg));

      // Patch MainApplication.kt to register VolumeKeyPackage.
      const mainAppPath = path.join(srcDir, "MainApplication.kt");
      if (fs.existsSync(mainAppPath)) {
        const src     = fs.readFileSync(mainAppPath, "utf8");
        const patched = patchMainApplication(src);
        fs.writeFileSync(mainAppPath, patched);
      }

      // Patch MainActivity.kt to override dispatchKeyEvent.
      const mainActivityPath = path.join(srcDir, "MainActivity.kt");
      if (fs.existsSync(mainActivityPath)) {
        const src     = fs.readFileSync(mainActivityPath, "utf8");
        const patched = patchMainActivity(src);
        fs.writeFileSync(mainActivityPath, patched);
      }

      return cfg;
    },
  ]);
};
