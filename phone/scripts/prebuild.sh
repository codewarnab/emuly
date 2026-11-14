#!/usr/bin/env bash
# Runs once in GitHub's codespace prebuild (onCreateCommand in .devcontainer/phone/devcontainer.json).
# 1. It installs the Android SDK, the system image and the AVD into the saved copy, so a new
#    phone skips about 3.5 min of downloads. setup.sh sees its stamp later and skips that work.
# 2. If the prebuild machine has KVM, it boots Android once and stops it. Android does its
#    one-time first-boot work then, so each new phone starts with a faster "second boot".
# Every failure is ignored: the first setup over SSH then does the work as before.
# The result goes to ~/.emuly-prebuild, so a phone shows what its prebuild did.
dir="$(cd "$(dirname "$0")" && pwd)"
report="$HOME/.emuly-prebuild"
note() { echo "prebuild: $*"; echo "$(date -u +%FT%TZ) $*" >> "$report"; }

: > "$report"
if EMULY_PREBUILD=1 bash "$dir/setup.sh"; then note "install ok"; else note "install failed"; exit 0; fi

if [ ! -e /dev/kvm ]; then note "kvm missing; first boot skipped"; exit 0; fi
# GitHub sets no documented prebuild signal. ~/emuly exists once the Emuly server has
# connected, which never happens in a prebuild. Then a phone is in use: do not boot or stop it.
if [ -d "$HOME/emuly" ]; then note "server already connected; first boot skipped"; exit 0; fi
note "kvm present"
start=$(date +%s)
if bash "$dir/boot.sh" cold; then
  note "first boot ok in $(( $(date +%s) - start )) s"
  # Android keeps compiling app code for a short time after boot completes. Give it a minute.
  sleep 60
else
  note "first boot failed"
fi
if [ -d "$HOME/emuly" ]; then note "server connected during the boot; Android left running"; exit 0; fi
if bash "$dir/stop.sh"; then note "stop ok"; else note "stop failed"; fi
# Leave no daemon running in the saved copy.
/opt/android-sdk/platform-tools/adb kill-server >/dev/null 2>&1 || true
exit 0
