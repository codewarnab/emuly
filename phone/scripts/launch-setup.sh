#!/usr/bin/env bash
# Starts run.sh in the background, in its own session, with a bounded setup.log, and writes its
# pid to .pid. Run it from ~/emuly. autostart.sh and the server's setup step both use it.
[ ! -f setup.log ] || mv -f setup.log setup.log.previous
nohup setsid bash -c 'bash run.sh 2>&1 | python3 scripts/bounded-log.py "$HOME/emuly/setup.log"' >/dev/null 2>&1 < /dev/null &
echo $! > .pid
