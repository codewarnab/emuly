#!/usr/bin/env bash
# Start the emuly runner on 127.0.0.1:8790 in the background.
set -euo pipefail
# shellcheck disable=SC2034 # progress.sh reads it
PH_PRODUCER=runner
source "$(dirname "$0")/progress.sh"
source "$(dirname "$0")/node-path.sh"
source "$(dirname "$0")/env.sh"
ph_begin runner_launch
builtin cd "$(dirname "$0")/.."
# KVM access resets on every codespace start. The runner must start even when KVM fails: its
# /health and /boot report the problem, and boot.sh fails on it. So a failure here is a warning.
if [ -e /dev/kvm ]; then kvm_fix || echo "WARN: KVM access could not be fixed; boot.sh reports it"; fi
command -v node >/dev/null || { echo "emuly: node is not on PATH"; exit 1; }
pkill -f "node runner/runner.mjs" 2>/dev/null || true
# The old runner finishes a running recording on SIGTERM (up to 5 s). Wait for it to exit,
# so the new runner does not read a recording that the old one still writes.
for _ in $(seq 1 60); do pgrep -f "node runner/runner.mjs" >/dev/null || break; sleep 0.1; done
[ ! -f /tmp/runner.log ] || mv -f /tmp/runner.log /tmp/runner.log.previous
nohup node runner/runner.mjs >/tmp/runner.log 2>&1 < /dev/null &
ph_end
echo "runner started (log: /tmp/runner.log)"
