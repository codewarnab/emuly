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

source "$(dirname "$0")/env.sh"
ADB="${ADB:-$SDK_DIR/platform-tools/adb}"
SERIALS=("$EMULATOR_SERIAL" "127.0.0.1:$EMULATOR_ADB_PORT" "127.0.0.1:$((EMULATOR_ADB_PORT + 1))")

if ! qemu_running; then
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
  "$ADB" -s "$EMULATOR_SERIAL" emu kill 2>/dev/null || true
else
  echo "stopping emulator@$SERIAL (graceful; no snapshot) ..."
  "$ADB" -s "$SERIAL" emu kill || true
fi

# qemu must exit before the codespace stops, or Android loses buffered writes
for _ in $(seq 1 60); do
  qemu_running || break
  sleep 2
done
qemu_running \
  && { echo "FATAL: qemu still alive after 120s"; exit 2; }
echo "emulator: fully exited (no snapshot saved)"
exit 0
