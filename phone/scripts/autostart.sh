#!/usr/bin/env bash
# Runs from the phone devcontainer's postStartCommand each time the codespace starts.
# It only starts what an earlier server setup installed: the server stays the one place
# that installs or updates files. Without a finished setup it does nothing, and the
# server's SSH setup runs as before.
# Saves the server's poll wait and SSH connect on a wake (measured 2026-11-14: ~35 s + 8 s).
set -u
EMULY="$HOME/emuly"
[ -f "$EMULY/.setup-done" ] && [ -f "$EMULY/run.sh" ] || exit 0
builtin cd "$EMULY" || exit 0
# Another start (the server's SSH setup) may already run.
if [ -f .pid ] && kill -0 "$(cat .pid)" 2>/dev/null; then exit 0; fi
export PATH="/usr/local/share/nvm/current/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
source scripts/node-path.sh
rm -f .failed
[ ! -f setup.log ] || mv -f setup.log setup.log.previous
# run.sh keeps the diagnostic operation of the setup that wrote it; the server ignores
# records for an operation that is no longer current.
nohup setsid bash -c 'bash run.sh 2>&1 | python3 scripts/bounded-log.py "$HOME/emuly/setup.log"' >/dev/null 2>&1 < /dev/null &
echo $! > .pid
exit 0
