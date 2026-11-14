#!/usr/bin/env bash
# Idempotent Android emulator setup for a GitHub Codespace.
# Pipe-run from OCI: gh codespace ssh -c <NAME> -- bash -s < oci-vm/android/emu-codespace/setup.sh
# Assumes Ubuntu 24.04 blank-template codespace (user "codespace" with passwordless sudo).
set -euo pipefail
# onCreateCommand (prebuild.sh) and the server's setup can start at the same time on a new
# codespace. Two sdkmanager runs in one SDK folder break it, so one setup waits for the other.
exec 8>/tmp/emuly-setup.lock
flock -w 900 8 || { echo "FATAL: another setup still runs after 900 s"; exit 1; }
source "$(dirname "$0")/progress.sh"
source "$(dirname "$0")/node-path.sh"
ph_begin kvm

SDK_DIR="${SDK_DIR:-/opt/android-sdk}"
AVD_NAME="${AVD_NAME:-t}"
IMAGE="${IMAGE:-system-images;android-36;google_apis;x86_64}"  # Android 16, default slot
CMD_TOOLS_ZIP="commandlinetools-linux-11076708_latest.zip"
CMD_TOOLS_URL="https://dl.google.com/android/repository/${CMD_TOOLS_ZIP}"

# EMULY_PREBUILD=1 (phone/scripts/prebuild.sh): install the SDK, the image and the AVD only.
# The prebuild machine may have no KVM, and the runner files arrive later from the server.
PREBUILD="${EMULY_PREBUILD:-0}"

# --- 1. KVM access (resets on every stop/start; re-applied here) ---
if [ "$PREBUILD" = 1 ]; then
  echo "KVM: skipped (prebuild)"
elif [ -e /dev/kvm ]; then
  sudo chgrp "$(id -gn)" /dev/kvm 2>/dev/null || sudo chmod 660 /dev/kvm
  sudo chmod 660 /dev/kvm
  test -r /dev/kvm && test -w /dev/kvm || { echo "FATAL: /dev/kvm not accessible even after fix"; exit 1; }
  echo "KVM: accessible"
else
  echo "FATAL: /dev/kvm missing on this codespace; KVM tier required"; exit 1
fi
ph_end

# --- 2. X11/runtime libs the emulator needs (blank template lacks them) ---
PKGS="libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 \
libxfixes3 libxi6 libxrandr2 libxrender1 libxtst6 libxkbcommon0 libnss3 libgl1 \
libegl1 libgbm1 libpulse0 unzip curl bubblewrap util-linux openjdk-21-jre-headless"
# Ubuntu 24.04 renamed libasound2; the codespace image may be older.
if apt-cache show libasound2t64 >/dev/null 2>&1; then PKGS="$PKGS libasound2t64"; else PKGS="$PKGS libasound2"; fi
ph_begin runtime_libraries
disposition=already_present
if ! dpkg -s $PKGS >/dev/null 2>&1; then
  disposition=installed
  # The image ships a yarn apt source whose key expired; it breaks apt-get update and we do not need it.
  sudo rm -f /etc/apt/sources.list.d/yarn.list
  sudo apt-get update -qq || echo "apt-get update reported errors; installing anyway"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $PKGS >/dev/null
fi
ph_end succeeded none "$disposition"
echo "X11 libs: installed"

# --- 3. Android SDK cmdline-tools ---
sudo mkdir -p "$SDK_DIR"
sudo chown -R "$(id -u):$(id -g)" "$SDK_DIR"
ph_begin sdk_tools
disposition=already_present
if [ ! -x "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" ]; then
  disposition=installed
  curl -fsSL "$CMD_TOOLS_URL" -o /tmp/tools.zip
  rm -rf /tmp/tools && unzip -qq /tmp/tools.zip -d /tmp/tools
  rm -rf "$SDK_DIR/cmdline-tools" /tmp/tools.zip
  mkdir -p "$SDK_DIR/cmdline-tools/latest"
  mv /tmp/tools/cmdline-tools/* "$SDK_DIR/cmdline-tools/latest/"
fi
ph_end succeeded none "$disposition"
export ANDROID_HOME="$SDK_DIR"
export PATH="$SDK_DIR/cmdline-tools/latest/bin:$SDK_DIR/platform-tools:$SDK_DIR/emulator:$PATH"

# --- 4. Licenses + minimal packages for a headless emulator ---
# Each sdkmanager call starts a JVM (2-7 s on a wake, more while the emulator boots).
# A stamp records the last good install; skip the calls while it still matches.
SDK_STAMP="$SDK_DIR/.emuly-sdk-ok"
SDK_WANT="$IMAGE|platform-tools|emulator|build-tools;36.0.0"
ph_begin sdk_packages
if [ "$(cat "$SDK_STAMP" 2>/dev/null)" = "$SDK_WANT" ] && [ -x "$SDK_DIR/emulator/emulator" ] \
  && [ -x "$SDK_DIR/platform-tools/adb" ] && [ -d "$SDK_DIR/system-images/android-36/google_apis/x86_64" ]; then
  ph_end succeeded none already_present
else
  yes | sdkmanager --licenses >/dev/null 2>&1 || true
  # Keep dependency resolution together until isolated comparison verifies splitting is equivalent.
  sdkmanager --install "platform-tools" "emulator" "build-tools;36.0.0" "$IMAGE" > /dev/null 2>&1 \
    || sdkmanager "platform-tools" "emulator" "build-tools;36.0.0" "$IMAGE" > /dev/null
  printf '%s' "$SDK_WANT" > "$SDK_STAMP"
  ph_end succeeded none installed
fi
echo "SDK: $IMAGE at $SDK_DIR"

# --- 4b. Android CLI (installed for interactive use; boot.sh does not use it) ---
# Measured 2026-11-09 (issue #15): boot.sh boots with the raw emulator and
# `-no-snapshot`. Do not go back to `android emulator start --cold`: it only
# skips the snapshot load and still writes a 1.76 GB snapshot on stop, which
# makes the next wake pay the slow load again.
ph_begin android_cli
disposition=already_present
if [ ! -x "$HOME/.local/bin/android" ]; then
  disposition=installed
  curl -fsSL https://dl.google.com/android/cli/latest/linux_x86_64/install.sh | bash -s -- 2>&1 | tail -1
fi
ph_end succeeded none "$disposition"
# Pin SDK + opt out of usage metrics
printf -- '--sdk=%s\n--no-metrics\n' "$SDK_DIR" > "$HOME/.androidrc"

# --- 5. AVD (skip if it already exists) ---
ph_begin avd
disposition=already_present
# A config.ini check avoids a 2 s avdmanager JVM start on every wake.
if [ ! -f "$HOME/.android/avd/${AVD_NAME}.avd/config.ini" ] && ! avdmanager list avd 2>/dev/null | grep -q "Path:.*${AVD_NAME}.avd"; then
  disposition=installed
  echo no | avdmanager create avd -n "$AVD_NAME" -k "$IMAGE"
  echo "AVD: created $AVD_NAME ($IMAGE)"
else
  echo "AVD: $AVD_NAME exists, left untouched (state preserved)"
fi
ph_end succeeded none "$disposition"

if [ "$PREBUILD" = 1 ]; then echo "PREBUILD OK: SDK, image and AVD are ready."; exit 0; fi
# Release the lock before later steps: a daemon they start would inherit fd 8 and hold it.
exec 8>&-

echo
echo "SETUP OK. Serial hint: emulator-5554 (boot.sh uses -port 5554)."
echo "Next: boot  ->  bash boot.sh"

# scrcpy wire protocol is versioned with this exact server binary.
SCRCPY_SHA=8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e
SCRCPY_FILE="$(dirname "$0")/../runner/scrcpy-server.jar"
ph_begin scrcpy
disposition=already_present
if ! echo "$SCRCPY_SHA  $SCRCPY_FILE" | sha256sum -c - >/dev/null 2>&1; then
  disposition=installed
  curl -fsSL https://github.com/Genymobile/scrcpy/releases/download/v3.3.4/scrcpy-server-v3.3.4 -o "$SCRCPY_FILE.tmp"
  echo "$SCRCPY_SHA  $SCRCPY_FILE.tmp" | sha256sum -c - || { rm -f "$SCRCPY_FILE.tmp"; exit 1; }
  mv "$SCRCPY_FILE.tmp" "$SCRCPY_FILE"
fi
ph_end succeeded none "$disposition"

# --- 6. agent-device CLI, pinned so the laptop CLI, the Codespace proxy and the API agree ---
ph_begin agent_device
disposition=already_present
INSTALLED_AGENT_DEVICE="$(agent-device --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
if [ -z "${AGENT_DEVICE_VERSION:-}" ]; then
  echo "agent-device: AGENT_DEVICE_VERSION is unset, skipping"
elif ! [[ "$AGENT_DEVICE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "agent-device: AGENT_DEVICE_VERSION is not a release version, skipping"
elif ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)' 2>/dev/null; then
  echo "WARNING: agent-device $AGENT_DEVICE_VERSION needs Node >= 22.12, skipping"
elif [ "$INSTALLED_AGENT_DEVICE" = "$AGENT_DEVICE_VERSION" ]; then
  echo "agent-device: $AGENT_DEVICE_VERSION already installed"
else
  disposition=installed
  # A failed CLI install must not fail Android setup; the runner works without it.
  if npm install -g "agent-device@$AGENT_DEVICE_VERSION" >/tmp/agent-device-install.log 2>&1; then
    echo "agent-device: installed $AGENT_DEVICE_VERSION"
  else
    disposition=unknown
    echo "WARNING: agent-device install failed; see /tmp/agent-device-install.log"
  fi
fi
ph_end succeeded none "$disposition"
