# shellcheck shell=bash
# Codespace ports for the shell scripts. The source of truth is phone/runner/contracts.mjs;
# lib/contracts.test.ts fails when the two differ.
# shellcheck disable=SC2034 # the scripts that source this file read them
EMULATOR_CONSOLE_PORT=5554
RUNNER_PORT=8790
EGRESS_PORT=8792
EMULATOR_ADB_PORT=5555
