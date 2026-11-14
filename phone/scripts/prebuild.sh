#!/usr/bin/env bash
# Runs once in GitHub's codespace prebuild (onCreateCommand in .devcontainer/phone/devcontainer.json).
# It installs the Android SDK, the system image and the AVD into the saved copy, so a new
# phone skips about 3.5 min of downloads. setup.sh sees its stamp later and skips that work.
# Every failure is ignored: the first setup over SSH then installs everything as before.
EMULY_PREBUILD=1 bash "$(dirname "$0")/setup.sh" || echo "prebuild: Android install failed; setup installs it later"
exit 0
