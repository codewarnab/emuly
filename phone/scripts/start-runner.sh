#!/usr/bin/env bash
# Start the phonelink runner on 127.0.0.1:8790 in the background.
set -euo pipefail
builtin cd "$(dirname "$0")/.."
# KVM access resets on every codespace start.
if [ -e /dev/kvm ]; then
  sudo chgrp "$(id -gn)" /dev/kvm 2>/dev/null || true
  sudo chmod 660 /dev/kvm || true
fi
command -v node >/dev/null || { echo "phonelink: node is not on PATH"; exit 1; }
pkill -f "node runner/runner.mjs" 2>/dev/null || true
nohup node runner/runner.mjs > /tmp/runner.log 2>&1 < /dev/null &
echo "runner started (log: /tmp/runner.log)"
