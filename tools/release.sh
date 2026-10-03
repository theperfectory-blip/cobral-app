#!/usr/bin/env bash
# Publishes a Cobral release the way the in-app updater expects (same model as tsc-web):
#   GitHub Release vX.Y with 3 assets: Cobral_vX.Y.apk (versioned), Cobral.apk (stable name used by cobral.web.app/descargar/)
#   and update.json ({versionCode, versionName, apkUrl, sha256, notes}) which installed apps read via
#   https://github.com/<repo>/releases/latest/download/update.json
# Safety checks (it refuses to publish otherwise): clean + pushed git tree; versionName/versionCode of build.gradle match the
# APK; the APK is signed with the SAME key as the apps already installed (an APK with another key can never update them).
# Usage: bash tools/release.sh <notes-file.md> [path/to/Cobral_vX.Y.apk]     (default APK: ../Cobral_v<versionName>.apk)
set -euo pipefail
cd "$(dirname "$0")/.."
NOTES="${1:?usage: bash tools/release.sh <notes-file> [apk]}"
REPO="theperfectory-blip/cobral-app"
EXPECTED_CERT="7701f436927ebfa652712b070f3a724757a6a642a716d32eb4d96d03ad4be619"   # ~/.android/debug.keystore of Jimbo's PC
export JAVA_HOME="/c/Users/Administrator/jdk-temurin-21/jdk-21.0.11+10" JAVA_TOOL_OPTIONS="-Djdk.net.unixdomain.tmpdir=C:/cobral-no-uds"
export PATH="$JAVA_HOME/bin:$PATH"
SDK="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"

VC=$(sed -nE 's/^[[:space:]]*versionCode ([0-9]+)$/\1/p' android/app/build.gradle)
VN=$(sed -nE 's/^[[:space:]]*versionName "([^"]+)"$/\1/p' android/app/build.gradle)
APK="${2:-../Cobral_v$VN.apk}"
[[ -f "$APK" ]] || { echo "APK not found: $APK"; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "working tree not clean — commit first"; exit 1; }
git fetch -q origin main; [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || { echo "HEAD is not pushed to origin/main"; exit 1; }
grep -q "<title>Cobral v$VN</title>" www/index.html || { echo "www/index.html <title> is not 'Cobral v$VN'"; exit 1; }

APKW=$(cygpath -w "$APK"); AS=$(cygpath -w "$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)/apksigner.bat")
CERT=$(cmd //c "$AS" verify --print-certs "$APKW" 2>&1 | sed -nE 's/.*certificate SHA-256 digest: ([0-9a-f]+).*/\1/p' | head -1)
[[ "$CERT" == "$EXPECTED_CERT" ]] || { echo "APK signing cert ($CERT) is not the one of the installed apps ($EXPECTED_CERT) — NOT publishing"; exit 1; }
BADGING=$(unzip -p "$APK" AndroidManifest.xml | wc -c); [[ "$BADGING" -gt 0 ]] || { echo "APK unreadable"; exit 1; }
# versionCode inside the APK must equal build.gradle (the updater compares codes)
INAPK=$("$SDK"/build-tools/*/aapt2.exe dump badging "$APKW" 2>/dev/null | sed -nE "s/.*versionCode='([0-9]+)'.*/\1/p" | head -1 || true)
[[ -z "$INAPK" || "$INAPK" == "$VC" ]] || { echo "versionCode in APK ($INAPK) != build.gradle ($VC)"; exit 1; }

TMP="$(mktemp -d)"; cp "$APK" "$TMP/Cobral.apk"; cp "$APK" "$TMP/Cobral_v$VN.apk"
SHA=$(sha256sum "$APK" | cut -d' ' -f1)
node -e '
const [vc, vn, repo, sha, notesFile, out] = process.argv.slice(1);
const fs = require("fs");
fs.writeFileSync(out, JSON.stringify({ versionCode: Number(vc), versionName: vn,
  apkUrl: `https://github.com/${repo}/releases/download/v${vn}/Cobral_v${vn}.apk`, sha256: sha,
  notes: fs.readFileSync(notesFile, "utf8").trim() }, null, 2) + "\n");
' "$VC" "$VN" "$REPO" "$SHA" "$NOTES" "$TMP/update.json"
echo "--- update.json"; cat "$TMP/update.json"
gh release create "v$VN" "$TMP/Cobral_v$VN.apk" "$TMP/Cobral.apk" "$TMP/update.json" --repo "$REPO" --target main --title "Cobral v$VN" --notes-file "$NOTES" --latest
echo "released v$VN (code $VC, sha256 $SHA)."
echo "Next: node tools/build-site.mjs && npx firebase deploy --only hosting:web --project cobral-app   (the download page shows this release's SHA)"
