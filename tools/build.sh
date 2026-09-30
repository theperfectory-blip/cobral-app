#!/usr/bin/env bash
# Build the debug APK from www/, install it on the running emulator/device and launch it.
# Usage: bash tools/build.sh [--sync]   (--sync also refreshes Capacitor plugins)
set -euo pipefail
cd "$(dirname "$0")/.."

export JAVA_HOME="/c/Users/Administrator/jdk-temurin-21/jdk-21.0.11+10"
export ANDROID_HOME="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"  # D:\AndroidData\Sdk on this PC (set as a user env var)
# This machine cannot create AF_UNIX sockets in %TEMP%; a non-existent dir makes the JDK fall back to TCP loopback.
export JAVA_TOOL_OPTIONS="-Djdk.net.unixdomain.tmpdir=C:/cobral-no-uds"
ADB="$ANDROID_HOME/platform-tools/adb.exe"
PKG=cl.cobral.ventas

node tools/check.mjs >/dev/null || { node tools/check.mjs; echo "Integrity check failed — not building"; exit 1; }

if [[ "${1:-}" == "--sync" ]]; then npx cap sync android; else npx cap copy android; fi

(cd android && ./gradlew assembleDebug -q --console=plain)
APK=android/app/build/outputs/apk/debug/app-debug.apk
ls -la "$APK"

# -r keeps app data (localStorage/IndexedDB), same as installing over the old APK on the phone
"$ADB" install -r "$APK"
"$ADB" shell am force-stop "$PKG"
"$ADB" shell am start -n "$PKG/.MainActivity" >/dev/null
echo "Installed and launched $PKG"

# Wait until the WebView is debuggable and the splash is gone, so tests can start immediately.
for i in $(seq 1 30); do
  r=$(node tools/cdp.mjs "typeof state!=='undefined'&&!document.getElementById('splashScreen')" 2>/dev/null || true)
  [[ "$r" == "true" ]] && { echo "App ready"; exit 0; }
  sleep 1
done
echo "App did not become ready in 30s"; exit 1
