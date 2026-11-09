#!/usr/bin/env bash
# Graceful emulator stop. No snapshot is saved: boot.sh runs with -no-snapshot.
# Pipe-run from a panel host:   gh codespace ssh -c <NAME> -- bash -s < scripts/stop.sh
# Then stop the codespace from the host:  gh codespace stop -c <NAME>
#
# Why `adb emu kill`: it asks the emulator console for an orderly shutdown, so
# Android flushes its data before qemu exits. `android emulator stop` kills qemu
# immediately. The stop costs about 2 s now that no 2.5 GB ram.bin is written
# (measured 2026-11-09, issue #15).
#
# Exit codes: 0 emulator stopped or not running; 2 qemu still alive.
set -uo pipefail

SDK_DIR="${SDK_DIR:-/opt/android-sdk}"
ADB="${ADB:-$SDK_DIR/platform-tools/adb}"
SERIALS=("emulator-5554" "127.0.0.1:5555" "127.0.0.1:5556")

if ! pgrep -f "qemu-system-x86_6[4]" >/dev/null 2>&1; then
  echo "emulator: not running (nothing to stop)"
  exit 0
fi

"$ADB" start-server >/dev/null 2>&1 || true

SERIAL=""
for s in "${SERIALS[@]}"; do
  if "$ADB" -s "$s" get-state >/dev/null 2>&1; then SERIAL="$s"; break; fi
done
if [ -z "$SERIAL" ]; then
  echo "WARN: qemu alive but no adb state; issuing blind emu kill on 5554"
  "$ADB" -s emulator-5554 emu kill 2>/dev/null || true
else
  echo "stopping emulator@$SERIAL (graceful; no snapshot) ..."
  "$ADB" -s "$SERIAL" emu kill || true
fi

# qemu must exit before the codespace stops, or Android loses buffered writes
for i in $(seq 1 60); do
  pgrep -f "qemu-system-x86_6[4]" >/dev/null 2>&1 || break
  sleep 2
done
pgrep -f "qemu-system-x86_6[4]" >/dev/null 2>&1 \
  && { echo "FATAL: qemu still alive after 120s"; exit 2; }
echo "emulator: fully exited (no snapshot saved)"
exit 0
