#!/usr/bin/env bash
# Graceful emulator stop that PRESERVES the quick-boot snapshot.
# Pipe-run from a panel host:   gh codespace ssh -c <NAME> -- bash -s < scripts/stop.sh
# Then stop the codespace from the host:  gh codespace stop -c <NAME>
#
# Why: `android emulator stop` (CLI) and plain codespace stop kill qemu BEFORE its
# snapshot save completes (dir left with an 11-byte snapshot.pb, no ram.bin) ->
# every next boot is a 63-157 s cold boot. Raw `adb emu kill` asks the emulator
# console for an orderly shutdown; qemu writes the full ram.bin (~2.5 GB) in
# seconds (disk ~530 MB/s) and the next boot resumes from snapshot in ~15 s.
# Measured 2026-10-30 on damp-cape (4c) — see homelab-docs issue #119 analysis.
#
# Exit codes: 0 snapshot preserved or no emulator running; 3 snapshot MISSING
# (tell-tale for a cold boot next time); other = environment failure.
set -uo pipefail

SDK_DIR="${SDK_DIR:-/opt/android-sdk}"
ADB="${ADB:-$SDK_DIR/platform-tools/adb}"
AVD_NAME="${AVD_NAME:-t}"
SNAP_DIR="$HOME/.android/avd/${AVD_NAME}.avd/snapshots/default_boot"
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
  echo "stopping emulator@$SERIAL (graceful, snapshot-saving) ..."
  "$ADB" -s "$SERIAL" emu kill || true
fi

# qemu must exit for the save to complete; ram.bin write is async-ish and fast
for i in $(seq 1 60); do
  pgrep -f "qemu-system-x86_6[4]" >/dev/null 2>&1 || break
  sleep 2
done
pgrep -f "qemu-system-x86_6[4]" >/dev/null 2>&1 \
  && { echo "FATAL: qemu still alive after 120s"; exit 2; }
echo "emulator: fully exited"

# Verify the snapshot actually landed (guard against the 11-byte stub bug)
if command -v stat >/dev/null 2>&1; then
  RAM_BYTES=$(stat -c %s "$SNAP_DIR/ram.bin" 2>/dev/null || echo 0)
else
  RAM_BYTES=$(wc -c < "$SNAP_DIR/ram.bin" 2>/dev/null || echo 0)
fi
if [ "${RAM_BYTES:-0}" -ge 1000000000 ]; then
  echo "SNAPSHOT_OK: ram.bin $(( RAM_BYTES / 1000000000 ))GB in $SNAP_DIR"
  echo "next boot will RESUME (~15s). Now stop the codespace: gh codespace stop"
  exit 0
fi
echo "SNAPSHOT_MISSING: ram.bin=${RAM_BYTES:-0}B — next boot will be COLD."
exit 3
