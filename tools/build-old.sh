#!/usr/bin/env bash
# Builds a DEBUGGABLE "old version" test APK from an old commit's web code (default: the v5.52 baseline) inside the current
# Android project, signed with the same debug key, and restores the working tree afterwards. Used by tools/upgrade-test.mjs
# because the real released v5.x APKs are not debuggable (no CDP access to fill them with data).
# Usage: bash tools/build-old.sh <out.apk> [commit=<first commit>] [versionCode=1] [versionName=5.52]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$1"; BASE="${2:-$(git rev-list --max-parents=0 HEAD | tail -1)}"; VC="${3:-1}"; VN="${4:-5.52}"
export JAVA_HOME="/c/Users/Administrator/jdk-temurin-21/jdk-21.0.11+10"
export JAVA_TOOL_OPTIONS="-Djdk.net.unixdomain.tmpdir=C:/cobral-no-uds"
export ANDROID_HOME="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
[[ -z "$(git status --porcelain www android/app/build.gradle)" ]] || { echo "www/ or build.gradle has uncommitted changes — commit or stash first"; exit 1; }
restore() { git checkout -- www android/app/build.gradle 2>/dev/null || true; npx cap copy android >/dev/null 2>&1 || true; }
trap restore EXIT
git show "$BASE:www/index.html" > www/index.html
sed -i -E "s/versionCode [0-9]+$/versionCode $VC/; s/versionName \"[^\"]*\"$/versionName \"$VN\"/" android/app/build.gradle
npx cap copy android >/dev/null
(cd android && ./gradlew assembleDebug -q --console=plain)
cp android/app/build/outputs/apk/debug/app-debug.apk "$OUT"
echo "built $OUT (code of ${BASE:0:8}, versionCode $VC, versionName $VN)"
