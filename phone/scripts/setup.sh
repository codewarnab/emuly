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
libegl1 libgbm1 libasound2t64 libpulse0 unzip curl"
if ! dpkg -s $PKGS >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq $PKGS >/dev/null
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
sdkmanager --install "platform-tools" "emulator" "$IMAGE" > /dev/null 2>&1 \
  || sdkmanager "platform-tools" "emulator" "$IMAGE" > /dev/null
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
