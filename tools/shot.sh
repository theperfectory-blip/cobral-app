#!/usr/bin/env bash
# Screenshot the emulator/device into tools/out/<name>.png
# Usage: bash tools/shot.sh <name>
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p tools/out
"$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" exec-out screencap -p > "tools/out/${1:-shot}.png"
echo "tools/out/${1:-shot}.png"
