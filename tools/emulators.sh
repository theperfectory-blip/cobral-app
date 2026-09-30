#!/usr/bin/env bash
# Start the local Firebase Auth + Firestore emulators (never the real project) and route the Android
# emulator's 127.0.0.1:9099/8080 to them with adb reverse. Run in the background; Ctrl+C to stop.
cd "$(dirname "$0")/.."
export JAVA_HOME="/c/Users/Administrator/jdk-temurin-21/jdk-21.0.11+10"
export PATH="$JAVA_HOME/bin:$PATH"
export JAVA_TOOL_OPTIONS="-Djdk.net.unixdomain.tmpdir=C:/cobral-no-uds"
ADB="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}/platform-tools/adb.exe"
"$ADB" reverse tcp:9099 tcp:9099 && "$ADB" reverse tcp:8080 tcp:8080
exec firebase emulators:start --only auth,firestore --project cobral-app
