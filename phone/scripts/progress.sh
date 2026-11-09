#!/usr/bin/env bash
# Private fixed-code progress. Failure of this helper must never affect phone work.
PH_PRODUCER="${PH_PRODUCER:-setup}"
PH_RUN=$(tr -d '-' < /proc/sys/kernel/random/uuid)
PH_SEQUENCE=0
PH_STEP=""
PH_DIR="$HOME/emuly/.progress/${PH_OPERATION_ID:-disabled}"
ph_time() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
ph_ms() { awk '{printf "%.0f", $1 * 1000}' /proc/uptime; }
ph_write() {
  [ "${EMULY_DIAGNOSTICS:-0}" = 1 ] || return 0
  [[ "${PH_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ ]] || return 0
  (
    umask 077
    [ ! -L "$HOME/emuly" ] && [ ! -L "$HOME/emuly/.progress" ] && [ ! -L "$PH_DIR" ] || exit 0
    mkdir -p "$PH_DIR"
    [ ! -L "$PH_DIR/records" ] && [ ! -L "$PH_DIR/lock" ] || exit 0
    exec 9>"$PH_DIR/lock"
    flock -w 1 9 || exit 0
    if [ "$(stat -c %s "$PH_DIR/records" 2>/dev/null || echo 0)" -ge 1000000 ]; then
      n=$(cat "$PH_DIR/dropped" 2>/dev/null || echo 0)
      [[ "$n" =~ ^[0-9]{1,5}$ ]] || n=0
      [ -L "$PH_DIR/dropped" ] || printf '%s\n' "$((n < 99999 ? n + 1 : 99999))" > "$PH_DIR/dropped"
      exit 0
    fi
    printf '%s\n' "$1" >> "$PH_DIR/records"
  ) 2>/dev/null || true
}
ph_record() {
  local finish="" disposition="" method="" exit_code=""
  [ "$1" = running ] || finish=",\"finishedAt\":\"$(ph_time)\",\"durationMs\":$(( $(ph_ms) - PH_START_MS ))"
  [ "$3" = unknown ] || disposition=",\"disposition\":\"$3\""
  if [ "$PH_CODE" = cli_boot ]; then method=',"bootMethod":"cli_unspecified"'; fi
  if [ "$PH_CODE" = fallback_boot ]; then method=',"bootMethod":"raw_fallback"'; fi
  [[ "${4:-}" =~ ^[0-9]{1,3}$ ]] && exit_code=",\"exitCode\":$4"
  ph_write "{\"stepId\":\"$PH_STEP\",\"producer\":\"$PH_PRODUCER\",\"producerRunId\":\"$PH_RUN\",\"sequence\":$PH_SEQUENCE,\"code\":\"$PH_CODE\",\"attempt\":1,\"startedAt\":\"$PH_START\",\"outcome\":\"$1\",\"errorCode\":\"$2\",\"quality\":\"exact\"$finish$disposition$method$exit_code}"
}
ph_begin() {
  PH_CODE="$1"; PH_SEQUENCE=$((PH_SEQUENCE + 1))
  PH_STEP=$(tr -d '-' < /proc/sys/kernel/random/uuid)
  PH_START=$(ph_time); PH_START_MS=$(ph_ms)
  ph_record running none unknown
}
ph_end() { ph_record "${1:-succeeded}" "${2:-none}" "${3:-unknown}" "${4:-}"; PH_STEP=""; }
ph_exit() {
  local code=$?
  if [ -n "$PH_STEP" ]; then
    if [ "$code" = 0 ]; then ph_end; else ph_end failed command_failed unknown "$code"; fi
  fi
}
trap ph_exit EXIT
trap '[ -z "$PH_STEP" ] || ph_end interrupted cancelled; exit 130' INT TERM HUP
