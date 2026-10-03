#!/usr/bin/env bash
# Builds a debug APK of the CURRENT code with a different versionCode/versionName (e.g. a "older" build to test the updater),
# then restores android/app/build.gradle. Usage: bash tools/build-variant.sh <out.apk> <versionCode> <versionName>
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$1"; VC="$2"; VN="$3"
export JAVA_HOME="/c/Users/Administrator/jdk-temurin-21/jdk-21.0.11+10"
export JAVA_TOOL_OPTIONS="-Djdk.net.unixdomain.tmpdir=C:/cobral-no-uds"
export ANDROID_HOME="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
cp android/app/build.gradle /tmp/build.gradle.bak
restore() { cp /tmp/build.gradle.bak android/app/build.gradle; }
trap restore EXIT
sed -i -E "s/versionCode [0-9]+$/versionCode $VC/; s/versionName \"[^\"]*\"$/versionName \"$VN\"/" android/app/build.gradle
npx cap copy android >/dev/null
(cd android && ./gradlew assembleDebug -q --console=plain)
cp android/app/build/outputs/apk/debug/app-debug.apk "$OUT"
echo "built $OUT (versionCode $VC, versionName $VN)"
