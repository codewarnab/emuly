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
# shellcheck disable=SC2034 # progress.sh reads it
PH_PRODUCER=boot
source "$(dirname "$0")/progress.sh"
source "$(dirname "$0")/env.sh"

MODE="${1:-cold}" # accepted for compatibility with POST /boot; every boot is cold
AVD_NAME="${2:-$AVD_NAME}"
LOG=/tmp/emulator.log
PORT=$EMULATOR_CONSOLE_PORT

# A cold boot starts every Google app at once on a cold disk, so some miss their
# startup limits and Android shows "isn't responding" dialogs. They recover by
# themselves; hide the dialogs so the first screen is usable (issue #15).
hide_anr_dialogs() {
  adb -s "emulator-$PORT" shell settings put global hide_error_dialogs 1 >/dev/null 2>&1 || true
}

# KVM access re-fix (resets on every codespace stop/start)
kvm_fix || exit 1

# Refuse to double-start (bracket trick so pkill via ssh can't kill itself).
# issue #15 P3: a wake can reach here while setup's early boot still runs, so join
# that boot instead of returning before Android is ready for POST /boot.
if qemu_running; then
  echo "ALREADY RUNNING. Attach with: adb connect localhost:$PORT"
  adb start-server >/dev/null 2>&1 || true
  joined=0
  # Check first, so an already booted phone returns at once. No ph_begin here: the
  # boot that owns qemu writes the boot progress records.
  # Check every second: the old 5 s step added up to 5 s to every ready time.
  for _ in $(seq 1 600); do
    if boot_completed; then
      joined=1; break
    fi
    qemu_running || { echo "EMULATOR DIED while joining. Last log:"; tail -20 "$LOG" 2>/dev/null || true; exit 1; }
    sleep 1
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

# Screen preset from the server (lib/shared/device-presets.ts), written by setup as device.env.
# Every boot is cold, so a config.ini edit here takes effect now. A missing device.env (a phone
# set up by an old server) gets the generic 720x1440 screen, not the 320x640 avdmanager default.
DEVICE_ENV="$HOME/emuly/device.env"
# shellcheck disable=SC1090
[ ! -f "$DEVICE_ENV" ] || source "$DEVICE_ENV"
# An old server wrote empty sizes for "generic": those also get 720x1440.
if [ -z "${EMULY_LCD_WIDTH:-}" ]; then
  EMULY_PRESET=generic EMULY_DEVICE="" EMULY_LCD_WIDTH=720 EMULY_LCD_HEIGHT=1440 EMULY_LCD_DENSITY=320
fi
cfg="$avd_dir/config.ini"
if [ -f "$cfg" ]; then
  # set_cfg (env.sh) for this one file. Self-contained: lib/shared/device-presets.test.ts runs this block alone.
  cfg_set() { sed -i "/^$1[ ]*=/d" "$cfg"; echo "$1=$2" >> "$cfg"; }
  cfg_set hw.lcd.width "$EMULY_LCD_WIDTH"
  cfg_set hw.lcd.height "$EMULY_LCD_HEIGHT"
  cfg_set hw.lcd.density "$EMULY_LCD_DENSITY"
  # A phone moved to a preset without a device id must not keep the old one.
  if [ -n "${EMULY_DEVICE:-}" ]; then cfg_set hw.device.name "$EMULY_DEVICE"; else sed -i '/^hw.device.name[ ]*=/d' "$cfg"; fi
  echo "preset: ${EMULY_PRESET:-generic} ${EMULY_LCD_WIDTH}x${EMULY_LCD_HEIGHT} ${EMULY_LCD_DENSITY}dpi"
fi

# 2 guest cores: cold boot 68 s -> 35 s and no startup ANRs (1 core before).
# 4 cores gave no further gain and leaves no CPU for SwiftShader and the encoder.
if [ -f "$avd_dir/config.ini" ]; then
  set_cfg "$avd_dir/config.ini" hw.cpu.ncore 2
fi

# 8 GB guest RAM. avdmanager writes hw.ramSize=96M, and the emulator then gives Android ~3.8 GB.
# Measured 2026-11-15 on standardLinux32gb (16 GB host), 2560x1600, 2 cores, warm disk:
#   default: boot 32.9 s, Android free 2000 MB, 4 app kills, qemu 4519 MB, host free 10279 MB
#   8192:    boot 33.0 s, Android free 5938 MB, 0 app kills, qemu 4671 MB, host free 10097 MB
# The boot time does not change; the gain is that apps the user opens stay in memory.
# The host pays only for pages Android uses, so the cost at boot is ~150 MB.
if [ -f "$avd_dir/config.ini" ]; then
  set_cfg "$avd_dir/config.ini" hw.ramSize 8192
fi

ph_begin adb_init
adb start-server >/dev/null 2>&1 || true
ph_end

# --- Raw emulator with verified headless flags (suite must stay explicit) ---
# No -no-audio: scrcpy captures Android's audio output inside the guest, so the phone needs an
# audio device. The host has no sound card; the emulator logs "Could not init 'pa' audio driver"
# and boots normally (2026-11-18: cold boot 51.5 s). With -no-audio, scrcpy sends only silence.
flags=(-no-window -no-boot-anim -gpu swiftshader_indirect -no-metrics
       -feature -Vulkan -camera-back none -camera-front none -port "$PORT"
       -no-snapshot)
# -no-snapshot skips the load AND stops the save on exit. The save is the 2.5 GB
# ram.bin write that made every stop take ~20 s and every wake load it again.
if [ "$MODE" = "resume" ]; then
  echo "note: resume requested; every boot is cold (issue #15)"
fi

# Egress (docs/phone-proxy-plan.md): every guest TCP connection goes to the runner gateway
# (egress.mjs on 127.0.0.1:8792), so `emuly proxy` can change the path with no restart.
# Gateway down = no internet for the phone (fail closed). It never goes direct.
flags+=(-http-proxy "http://127.0.0.1:$EGRESS_PORT")
# DNS goes to egress-dns.mjs on 127.0.0.77:53 (127.0.0.53 is systemd-resolved). Port 53 needs
# a copy of node with cap_net_bind_service. If that fails, DNS stays on the codespace resolver.
source "$(dirname "$0")/node-path.sh"
node53=/tmp/emuly-node53
if [ ! -x "$node53" ] && command -v node >/dev/null; then
  cp "$(command -v node)" "$node53" && sudo -n setcap cap_net_bind_service=+ep "$node53" 2>/dev/null || rm -f "$node53"
fi
if [ -x "$node53" ] && ! pgrep -f "emuly-node53 .*egress-dns.mj[s]" >/dev/null; then
  setsid nohup "$node53" "$(cd "$(dirname "$0")/../runner" && pwd)/egress-dns.mjs" >/tmp/emuly-dns.log 2>&1 </dev/null &
  for _ in $(seq 1 20); do grep -q "emuly dns on" /tmp/emuly-dns.log 2>/dev/null && break; sleep 0.1; done
fi
if pgrep -f "emuly-node53 .*egress-dns.mj[s]" >/dev/null; then
  flags+=(-dns-server 127.0.0.77)
else
  echo "note: egress dns did not start; the phone uses the codespace resolver"
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
for _ in $(seq 1 600); do
  sleep 1
  if boot_completed; then
    booted=1; break
  fi
  kill -0 "$EMU_PID" 2>/dev/null || { echo "EMULATOR DIED. Last log:"; tail -20 "$LOG"; exit 1; }
done
[ "$booted" = 1 ] || { echo "TIMEOUT: no boot in 10 min. Last log:"; tail -20 "$LOG"; exit 1; }
ph_end

hide_anr_dialogs
echo "BOOTED (cold): adb -s emulator-$PORT"
adb -s "emulator-$PORT" shell getprop ro.build.version.release | sed 's/^/android=/'
