#!/usr/bin/env bash
# JS errors/console output from the Cobral WebView since the last `--clear` (only Cobral's own process).
# Usage: bash tools/errors.sh --clear   (before a test)
#        bash tools/errors.sh           (after: prints uncaught errors, exit 1 if any)
ADB="$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"
if [[ "${1:-}" == "--clear" ]]; then "$ADB" logcat -c; echo "logcat cleared"; exit 0; fi
pid=$("$ADB" shell pidof cl.cobral.ventas | tr -d '\r')
[[ -z "$pid" ]] && { echo "cl.cobral.ventas is not running"; exit 1; }
# Ignored noise: sw.js addAll (pre-existing, fixed in C1), WebView variations seed, emulator GPU EGL messages.
out=$("$ADB" logcat -d --pid="$pid" -s chromium:* Capacitor/Console:* 2>/dev/null | grep -iE "uncaught|error|exception" \
  | grep -v "SW no disponible" | grep -v "sw.js" | grep -v "variations_seed" | grep -v "scoped_egl_image")
if [[ -n "$out" ]]; then echo "$out"; exit 1; else echo "no JS errors"; fi
