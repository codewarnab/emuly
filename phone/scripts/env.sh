# shellcheck shell=bash
# Shared setup for the phone scripts: the SDK path, the AVD name, the emulator serial, the SDK
# PATH and small helpers. boot.sh, setup.sh, stop.sh and start-runner.sh source it.
source "$(dirname "${BASH_SOURCE[0]}")/ports.sh"

SDK_DIR="${SDK_DIR:-/opt/android-sdk}"
# Always "t": a stray AVD_NAME in the codespace environment must not pick a missing AVD.
# shellcheck disable=SC2034 # the scripts that source this file read it
AVD_NAME=t
# shellcheck disable=SC2034 # the scripts that source this file read it
EMULATOR_SERIAL="emulator-$EMULATOR_CONSOLE_PORT"
export ANDROID_HOME="$SDK_DIR"
export PATH="$HOME/.local/bin:$SDK_DIR/platform-tools:$SDK_DIR/emulator:$SDK_DIR/cmdline-tools/latest/bin:$PATH"

# True while the emulator's qemu runs. The bracket keeps pgrep (and pkill over ssh) from matching itself.
qemu_running() { pgrep -f "qemu-system-x86_6[4]" >/dev/null 2>&1; }

# True when Android reports that it finished booting.
boot_completed() {
  [ "$(adb -s "$EMULATOR_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')" = "1" ]
}

# KVM access resets on every codespace stop and start. Give this user read and write access.
# Fails (status 1, with a FATAL line) when /dev/kvm is missing or stays closed.
kvm_fix() {
  [ -e /dev/kvm ] || { echo "FATAL: /dev/kvm missing on this codespace; KVM tier required"; return 1; }
  sudo chgrp "$(id -gn)" /dev/kvm 2>/dev/null || true
  sudo chmod 660 /dev/kvm 2>/dev/null || true
  { test -r /dev/kvm && test -w /dev/kvm; } || { echo "FATAL: /dev/kvm not accessible even after fix"; return 1; }
}

# set_cfg <file> <key> <value>: one key=value line in an AVD config.ini.
set_cfg() { sed -i "/^$2[ ]*=/d" "$1"; echo "$2=$3" >> "$1"; }
