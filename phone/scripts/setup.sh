#!/usr/bin/env bash
# Idempotent Android emulator setup for a GitHub Codespace.
# Pipe-run from OCI: gh codespace ssh -c <NAME> -- bash -s < oci-vm/android/emu-codespace/setup.sh
# Assumes Ubuntu 24.04 blank-template codespace (user "codespace" with passwordless sudo).
set -euo pipefail

SDK_DIR="${SDK_DIR:-/opt/android-sdk}"
AVD_NAME="${AVD_NAME:-t}"
IMAGE="${IMAGE:-system-images;android-36;google_apis;x86_64}"  # Android 16, default slot
CMD_TOOLS_ZIP="commandlinetools-linux-11076708_latest.zip"
CMD_TOOLS_URL="https://dl.google.com/android/repository/${CMD_TOOLS_ZIP}"

# --- 1. KVM access (resets on every stop/start; re-applied here) ---
if [ -e /dev/kvm ]; then
  sudo chgrp "$(id -gn)" /dev/kvm 2>/dev/null || sudo chmod 660 /dev/kvm
  sudo chmod 660 /dev/kvm
  test -r /dev/kvm && test -w /dev/kvm || { echo "FATAL: /dev/kvm not accessible even after fix"; exit 1; }
  echo "KVM: accessible"
else
  echo "FATAL: /dev/kvm missing on this codespace; KVM tier required"; exit 1
fi

# --- 2. X11/runtime libs the emulator needs (blank template lacks them) ---
PKGS="libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 \
libxfixes3 libxi6 libxrandr2 libxrender1 libxtst6 libxkbcommon0 libnss3 libgl1 \
libegl1 libgbm1 libpulse0 unzip curl bubblewrap util-linux openjdk-21-jre-headless"
# Ubuntu 24.04 renamed libasound2; the codespace image may be older.
if apt-cache show libasound2t64 >/dev/null 2>&1; then PKGS="$PKGS libasound2t64"; else PKGS="$PKGS libasound2"; fi
if ! dpkg -s $PKGS >/dev/null 2>&1; then
  # The image ships a yarn apt source whose key expired; it breaks apt-get update and we do not need it.
  sudo rm -f /etc/apt/sources.list.d/yarn.list
  sudo apt-get update -qq || echo "apt-get update reported errors; installing anyway"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $PKGS >/dev/null
fi
echo "X11 libs: installed"

# --- 3. Android SDK cmdline-tools ---
sudo mkdir -p "$SDK_DIR"
sudo chown -R "$(id -u):$(id -g)" "$SDK_DIR"
if [ ! -x "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" ]; then
  curl -fsSL "$CMD_TOOLS_URL" -o /tmp/tools.zip
  rm -rf /tmp/tools && unzip -qq /tmp/tools.zip -d /tmp/tools
  rm -rf "$SDK_DIR/cmdline-tools" /tmp/tools.zip
  mkdir -p "$SDK_DIR/cmdline-tools/latest"
  mv /tmp/tools/cmdline-tools/* "$SDK_DIR/cmdline-tools/latest/"
fi
export ANDROID_HOME="$SDK_DIR"
export PATH="$SDK_DIR/cmdline-tools/latest/bin:$SDK_DIR/platform-tools:$SDK_DIR/emulator:$PATH"

# --- 4. Licenses + minimal packages for a headless emulator ---
yes | sdkmanager --licenses >/dev/null 2>&1 || true
sdkmanager --install "platform-tools" "emulator" "build-tools;36.0.0" "$IMAGE" > /dev/null 2>&1 \
  || sdkmanager "platform-tools" "emulator" "build-tools;36.0.0" "$IMAGE" > /dev/null
echo "SDK: $IMAGE at $SDK_DIR"

# --- 4b. Android CLI (primary device/emulator manager for agents) ---
# Verified 2026-10-30: boots headless KVM OK (no -feature -Vulkan hack needed),
# cold boot ~100s; snapshot resume ~15s after a graceful `adb emu kill`
# (stop.sh). `android emulator stop` kills qemu before the snapshot save
# completes -> destroys it -> 63s+ cold boots. NEVER use it.
if [ ! -x "$HOME/.local/bin/android" ]; then
  curl -fsSL https://dl.google.com/android/cli/latest/linux_x86_64/install.sh | bash -s -- 2>&1 | tail -1
fi
# Pin SDK + opt out of usage metrics
printf -- '--sdk=%s\n--no-metrics\n' "$SDK_DIR" > "$HOME/.androidrc"

# --- 5. AVD (skip if it already exists) ---
if ! avdmanager list avd 2>/dev/null | grep -q "Path:.*${AVD_NAME}.avd"; then
  echo no | avdmanager create avd -n "$AVD_NAME" -k "$IMAGE"
  echo "AVD: created $AVD_NAME ($IMAGE)"
else
  echo "AVD: $AVD_NAME exists, left untouched (state preserved)"
fi

echo
echo "SETUP OK. Serial hint: emulator-5554 (boot.sh uses -port 5554)."
echo "Next: boot  ->  bash boot.sh cold|resume"
echo "State mgmt ->  bash state.sh export|import"

# scrcpy wire protocol is versioned with this exact server binary.
SCRCPY_SHA=8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e
SCRCPY_FILE="$(dirname "$0")/../runner/scrcpy-server.jar"
if ! echo "$SCRCPY_SHA  $SCRCPY_FILE" | sha256sum -c - >/dev/null 2>&1; then
  curl -fsSL https://github.com/Genymobile/scrcpy/releases/download/v3.3.4/scrcpy-server-v3.3.4 -o "$SCRCPY_FILE.tmp"
  echo "$SCRCPY_SHA  $SCRCPY_FILE.tmp" | sha256sum -c - || { rm -f "$SCRCPY_FILE.tmp"; exit 1; }
  mv "$SCRCPY_FILE.tmp" "$SCRCPY_FILE"
fi
