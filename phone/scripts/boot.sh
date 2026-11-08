#!/usr/bin/env bash
# Boot (or resume) the Android emulator inside a Codespace, wait for boot.
# Run inside codespace: bash boot.sh [cold|resume] [AVD_NAME]
# cold/resume only matter for the FALLBACK raw path; the primary Android CLI
# manager loads the saved snapshot automatically after a graceful `emu kill`
# (always stop via stop.sh — `android emulator stop` DESTROYS the snapshot).
set -euo pipefail
PH_PRODUCER=boot
source "$(dirname "$0")/progress.sh"

MODE="${1:-cold}"
AVD_NAME="${2:-t}"
SDK_DIR="${SDK_DIR:-/opt/android-sdk}"
export ANDROID_HOME="$SDK_DIR"
export PATH="$HOME/.local/bin:$SDK_DIR/platform-tools:$SDK_DIR/emulator:$SDK_DIR/cmdline-tools/latest/bin:$PATH"
LOG=/tmp/emulator.log
PORT=5554

# KVM access re-fix (resets on every codespace stop/start)
[ -e /dev/kvm ] || { echo "FATAL: /dev/kvm missing"; exit 1; }
sudo chgrp "$(id -gn)" /dev/kvm 2>/dev/null || true
sudo chmod 660 /dev/kvm

# Refuse to double-start (bracket trick so pkill via ssh can't kill itself)
if pgrep -f "qemu-system-x86_6[4]" >/dev/null 2>&1; then
  echo "ALREADY RUNNING. Attach with: adb connect localhost:$PORT"
  exit 0
fi

[ -d "$HOME/.android/avd/${AVD_NAME}.avd" ] \
  || { echo "FATAL: AVD $AVD_NAME missing. Run setup.sh first."; exit 1; }
ph_begin adb_init
adb start-server >/dev/null 2>&1 || true
ph_end

# --- Primary: Android CLI (blocks until 'fully started', then detaches) ---
if command -v android >/dev/null 2>&1; then
  ph_begin cli_boot
  start_ts=$(date +%s)
  if timeout 420 android emulator start --headless "$AVD_NAME" > >(nohup setsid python3 "$(dirname "$0")/bounded-log.py" "$LOG" >/dev/null 2>&1) 2>&1; then
    ph_end
    tr '\r' '\n' < "$LOG" | grep -v "Waiting for virtual" | tail -2
    echo "BOOTED (CLI) in $(( $(date +%s) - start_ts ))s: adb -s emulator-$PORT"
    echo "android: $(adb -s "emulator-$PORT" shell getprop ro.build.version.release | tr -d '[:space:]' | sed 's/^/API /')"
    exit 0
  else
    cli_exit=$?
    ph_end failed command_failed unknown "$cli_exit"
  fi
  echo "CLI start failed (tail of /tmp/emulator.log):"; tail -10 "$LOG"; echo "Falling back to raw emulator..."
fi

# --- Fallback: raw emulator with verified headless flags (suite must stay explicit) ---
flags=(-no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-metrics
       -feature -Vulkan -camera-back none -camera-front none -port "$PORT")
case "$MODE" in
  cold)   flags+=(-no-snapshot) ;;
  resume) : ;; # default behavior: load quick-boot snapshot if a clean shutdown saved one
  *) echo "usage: boot.sh [cold|resume] [AVD_NAME]"; exit 1 ;;
esac

mv -f "$LOG" "$LOG.cli" 2>/dev/null || true
ph_begin fallback_boot
setsid "$SDK_DIR/emulator/emulator" -avd "$AVD_NAME" "${flags[@]}" \
  > >(nohup setsid python3 "$(dirname "$0")/bounded-log.py" "$LOG" >/dev/null 2>&1) 2>&1 </dev/null &
EMU_PID=$!
ph_end
echo "emulator started pid=$EMU_PID avd=$AVD_NAME mode=$MODE port=$PORT"

booted=0
ph_begin boot_completed
for i in $(seq 1 120); do
  sleep 5
  if [ "$(adb -s "emulator-$PORT" shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')" = "1" ]; then
    booted=1; break
  fi
  kill -0 "$EMU_PID" 2>/dev/null || { echo "EMULATOR DIED. Last log:"; tail -20 "$LOG"; exit 1; }
done
[ "$booted" = 1 ] || { echo "TIMEOUT: no boot in 10 min. Last log:"; tail -20 "$LOG"; exit 1; }
ph_end

echo "BOOTED (raw fallback): adb -s emulator-$PORT"
adb -s "emulator-$PORT" shell getprop ro.build.version.release | sed 's/^/android=/'
