#!/usr/bin/env bash
# JS errors/console output from the Cobral WebView since the last `--clear`.
# Usage: bash tools/errors.sh --clear   (before a test)
#        bash tools/errors.sh           (after: prints uncaught errors, exit 1 if any)
ADB="$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"
if [[ "${1:-}" == "--clear" ]]; then "$ADB" logcat -c; echo "logcat cleared"; exit 0; fi
out=$("$ADB" logcat -d -s chromium:* Capacitor/Console:* 2>/dev/null | grep -iE "uncaught|error|exception" | grep -v "SW no disponible")
if [[ -n "$out" ]]; then echo "$out"; exit 1; else echo "no JS errors"; fi
