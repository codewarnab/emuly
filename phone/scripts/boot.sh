#!/usr/bin/env bash
# Boot the Android emulator inside a Codespace, wait for boot.
# Run inside codespace: bash boot.sh [cold|resume] [AVD_NAME]
# Every boot is a cold boot. The raw emulator runs with -no-snapshot, which
# skips the snapshot load and stops the snapshot save on exit.
# Measured 2026-11-09 (issue #15): after a codespace restart a snapshot load
# costs 163-201 s while a cold boot costs 108-145 s, and the save costs ~20 s
# on every stop. The Android CLI path was removed because
# `android emulator start --cold` still saved a 1.76 GB snapshot.
# The first argument is accepted for compatibility and ignored.
set -euo pipefail
PH_PRODUCER=boot
source "$(dirname "$0")/progress.sh"

MODE="${1:-cold}" # accepted for compatibility with POST /boot; every boot is cold
AVD_NAME="${2:-t}"
SDK_DIR="${SDK_DIR:-/opt/android-sdk}"
export ANDROID_HOME="$SDK_DIR"
export PATH="$HOME/.local/bin:$SDK_DIR/platform-tools:$SDK_DIR/emulator:$SDK_DIR/cmdline-tools/latest/bin:$PATH"
LOG=/tmp/emulator.log
PORT=5554

# A cold boot starts every Google app at once on a cold disk, so some miss their
# startup limits and Android shows "isn't responding" dialogs. They recover by
# themselves; hide the dialogs so the first screen is usable (issue #15).
hide_anr_dialogs() {
  adb -s "emulator-$PORT" shell settings put global hide_error_dialogs 1 >/dev/null 2>&1 || true
}

# KVM access re-fix (resets on every codespace stop/start)
[ -e /dev/kvm ] || { echo "FATAL: /dev/kvm missing"; exit 1; }
sudo chgrp "$(id -gn)" /dev/kvm 2>/dev/null || true
sudo chmod 660 /dev/kvm

# Refuse to double-start (bracket trick so pkill via ssh can't kill itself).
# issue #15 P3: a wake can reach here while setup's early boot still runs, so join
# that boot instead of returning before Android is ready for POST /boot.
if pgrep -f "qemu-system-x86_6[4]" >/dev/null 2>&1; then
  echo "ALREADY RUNNING. Attach with: adb connect localhost:$PORT"
  adb start-server >/dev/null 2>&1 || true
  joined=0
  # Check first, so an already booted phone returns at once. No ph_begin here: the
  # boot that owns qemu writes the boot progress records.
  for i in $(seq 1 120); do
    if [ "$(adb -s "emulator-$PORT" shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')" = "1" ]; then
      joined=1; break
    fi
    pgrep -f "qemu-system-x86_6[4]" >/dev/null 2>&1 || { echo "EMULATOR DIED while joining. Last log:"; tail -20 "$LOG" 2>/dev/null || true; exit 1; }
    sleep 5
  done
  [ "$joined" = 1 ] || { echo "TIMEOUT: emulator did not finish booting."; exit 1; }
  hide_anr_dialogs
  echo "BOOTED (joined): adb -s emulator-$PORT"
  exit 0
fi

avd_dir="$HOME/.android/avd/${AVD_NAME}.avd"
[ -d "$avd_dir" ] || { echo "FATAL: AVD $AVD_NAME missing. Run setup.sh first."; exit 1; }

# A qemu process killed mid-snapshot leaves a lock behind. The next start then
# fails with: FATAL | A snapshot operation for '<avd>' is pending and timeout
# has expired. No qemu runs at this point (checked above), so every lock is stale.
mapfile -t stale_locks < <(
  find "$avd_dir" -maxdepth 3 -type f -name '*.lock' 2>/dev/null
  if [ -f "$avd_dir.lock" ]; then echo "$avd_dir.lock"; fi
)
if [ "${#stale_locks[@]}" -gt 0 ]; then
  echo "removing stale emulator locks: ${stale_locks[*]}"
  rm -f -- "${stale_locks[@]}"
fi

ph_begin adb_init
adb start-server >/dev/null 2>&1 || true
ph_end

# --- Raw emulator with verified headless flags (suite must stay explicit) ---
flags=(-no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-metrics
       -feature -Vulkan -camera-back none -camera-front none -port "$PORT"
       -no-snapshot)
# -no-snapshot skips the load AND stops the save on exit. The save is the 2.5 GB
# ram.bin write that made every stop take ~20 s and every wake load it again.
if [ "$MODE" = "resume" ]; then
  echo "note: resume requested; every boot is cold (issue #15)"
fi

# Keep the previous boot's log so a bad boot can be compared with the last one.
mv -f "$LOG" "$LOG.cli" 2>/dev/null || true
# Phase code stays "fallback_boot": diagnostics map it to bootMethod=raw_fallback.
ph_begin fallback_boot
setsid "$SDK_DIR/emulator/emulator" -avd "$AVD_NAME" "${flags[@]}" \
  > >(nohup setsid python3 "$(dirname "$0")/bounded-log.py" "$LOG" >/dev/null 2>&1) 2>&1 </dev/null &
EMU_PID=$!
ph_end
echo "emulator started pid=$EMU_PID avd=$AVD_NAME mode=cold port=$PORT"

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

hide_anr_dialogs
echo "BOOTED (cold): adb -s emulator-$PORT"
adb -s "emulator-$PORT" shell getprop ro.build.version.release | sed 's/^/android=/'
