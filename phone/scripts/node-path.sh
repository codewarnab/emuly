#!/usr/bin/env bash
# Put the newest nvm Node first on PATH. In a prebuilt codespace, GitHub's build step can
# point nvm "current" at Node 16 (seen 2026-11-14), and the runner needs Node >= 22.12.
newest_node="$(ls -d /usr/local/share/nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -n 1)"
[ -z "$newest_node" ] || export PATH="$newest_node:$PATH"
unset newest_node
