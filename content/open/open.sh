#!/bin/sh
# Emuly: open one phone in a scrcpy window on this computer (macOS and Linux).
# Served by {{EMULY_BASE_URL}}/open/{{PHONE_ID}}.sh. It holds no key and no token.
# Run:   curl -fsSL {{EMULY_BASE_URL}}/open/{{PHONE_ID}}.sh | sh
# Flags: curl -fsSL ... | sh -s -- --yes --port 5560 --account <login> --no-install --uninstall
# POSIX sh only (Ubuntu runs dash). The script comes in on stdin, so every question reads /dev/tty.

PHONE='{{PHONE_ID}}'
BASE='{{EMULY_BASE_URL}}'
PAGE_URL="$BASE/app/phones/$PHONE"
SCRCPY_VERSION='5.0.1'
GH_VERSION='2.104.0'
TOOLS="${XDG_DATA_HOME:-$HOME/.local/share}/emuly/tools"

sum_for() {
  case "$1" in
    scrcpy-linux-x86_64-v5.0.1.tar.gz) echo 9f969d30cc574816077edecda65719c1c70b0aee1df1ba5fa00779ac07b8fd6e ;;
    scrcpy-macos-aarch64-v5.0.1.tar.gz) echo 33611e51977a8289e2e124b220f727895181ef2eb9060e0987a4dc2db9cf0d6b ;;
    scrcpy-macos-x86_64-v5.0.1.tar.gz) echo 31a5467a9e907f162b093267cbbab1276b15c6e709c2ea8159566a8d165beb50 ;;
    gh_2.104.0_linux_amd64.tar.gz) echo 98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e ;;
    gh_2.104.0_linux_arm64.tar.gz) echo cb34cefc6f4e77b90731374a2b737516bb8f3033c6ca46aa949e5344f68069e3 ;;
    gh_2.104.0_macOS_amd64.zip) echo a8c2a708dbae89dc7c05ba7b0beafc95bd8d09ab4a3505467b77d32ebf364dc6 ;;
    gh_2.104.0_macOS_arm64.zip) echo 23b12706219b9892e44236f988444a24adcf29284e16b35e03ba5b863fb6eb8e ;;
  esac
}

YES=0; NO_INSTALL=0; UNINSTALL=0; PORT=''; ACCOUNT=''
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --no-install) NO_INSTALL=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --port) PORT="$2"; shift ;;
    --account) ACCOUNT="$2"; shift ;;
  esac
  shift
done

# ---------- Output ----------
if [ -t 1 ]; then
  CL='\r\033[2K'; UP='\033[1A'
  C_DIM='\033[2m'; C_CYAN='\033[36m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'; C_BOLD='\033[1m'; C_OFF='\033[0m'
else
  # Not a terminal (a log file): no cursor moves, one line per update.
  CL='\n'; UP=''; C_DIM=''; C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BOLD=''; C_OFF=''
fi
case "${LANG:-}${LC_ALL:-}${LC_CTYPE:-}" in
  *UTF-8*|*utf8*|*UTF8*|*utf-8*) BAR='│'; STEP='◇'; ASK='◆'; OK='✔'; WARN='▲'; ERR='✖'; ON='●'; OFF='○'; END='└'; SPIN='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' ;;
  *) BAR='|'; STEP='o'; ASK='?'; OK='+'; WARN='!'; ERR='x'; ON='>'; OFF=' '; END='\'; SPIN='|/-\' ;;
esac
line() { printf "${C_DIM}%s${C_OFF}  %s\n" "$BAR" "$1"; }
step() { printf "%s  ${C_BOLD}%s${C_OFF}\n" "$STEP" "$1"; }
ok()   { printf "${C_DIM}%s${C_OFF}  ${C_GREEN}%s${C_OFF} %s\n" "$BAR" "$OK" "$1"; }
warn() { printf "${C_DIM}%s${C_OFF}  ${C_YELLOW}%s %s${C_OFF}\n" "$BAR" "$WARN" "$1"; }
fail() { printf "${C_DIM}%s${C_OFF}  ${C_RED}%s %s${C_OFF}\n" "$BAR" "$ERR" "$1"; }
done_() { printf "${C_CYAN}%s  %s${C_OFF}\n" "$END" "$1"; }
halt() { fail "$1"; echo; exit 1; }

TTY=''
if [ -r /dev/tty ] && [ -w /dev/tty ] && (exec </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi

# Reads one key from the terminal. Prints up, down, enter, esc, y, n or the character.
read_key() {
  old=$(stty -g <"$TTY")
  stty -icanon -echo min 1 time 0 <"$TTY"
  k=$(dd bs=1 count=1 <"$TTY" 2>/dev/null | od -An -c | tr -d ' ')
  if [ "$k" = '033' ]; then
    stty min 0 time 1 <"$TTY"
    rest=$(dd bs=2 count=1 <"$TTY" 2>/dev/null)
    stty "$old" <"$TTY"
    case "$rest" in '[A'|OA) echo up ;; '[B'|OB) echo down ;; '') echo esc ;; *) echo other ;; esac
    return
  fi
  stty "$old" <"$TTY"
  case "$k" in '\n'|'\r') echo enter ;; '\t') echo down ;; k|K) echo up ;; j|J) echo down ;; *) echo "$k" ;; esac
}

# choose "question" "option 1" "option 2" ... ; sets CHOICE to the index, from 0.
# Arrow keys or j/k move, Enter picks, y/n answer a yes/no question, Esc stops.
choose() {
  q="$1"; shift
  printf "${C_CYAN}%s  %s${C_OFF}\n" "$ASK" "$q"
  count=$#; CHOICE=0
  if [ -z "$TTY" ]; then line "$ON $1  (no keyboard: default)"; return; fi
  draw() {
    i=0
    for o in "$@"; do
      if [ $i -eq $CHOICE ]; then printf "\033[2K${C_DIM}%s${C_OFF}  ${C_CYAN}%s %s${C_OFF}\n" "$BAR" "$ON" "$o"
      else printf "\033[2K${C_DIM}%s${C_OFF}  ${C_DIM}%s %s${C_OFF}\n" "$BAR" "$OFF" "$o"; fi
      i=$((i + 1))
    done
  }
  printf '\033[?25l' >"$TTY"
  draw "$@"
  while :; do
    key=$(read_key)
    case "$key" in
      up) CHOICE=$(( (CHOICE - 1 + count) % count )) ;;
      down) CHOICE=$(( (CHOICE + 1) % count )) ;;
      enter) break ;;
      esc) printf '\033[?25h' >"$TTY"; halt 'Stopped.' ;;
      y|Y) [ $count -eq 2 ] && { CHOICE=0; printf "\033[${count}A"; draw "$@"; break; } ;;
      n|N) [ $count -eq 2 ] && { CHOICE=1; printf "\033[${count}A"; draw "$@"; break; } ;;
    esac
    printf "\033[${count}A"
    draw "$@"
  done
  printf '\033[?25h' >"$TTY"
}
confirm() {
  if [ $YES -eq 1 ]; then printf "${C_CYAN}%s  %s${C_OFF}\n" "$ASK" "$1"; line "$ON Yes  (--yes)"; return 0; fi
  choose "$1" 'Yes' 'No'; [ $CHOICE -eq 0 ]
}

# wait_until "text" seconds "command" ["slow hint" slow_after] ; runs the command every 0.5 s.
wait_until() {
  text="$1"; limit="$2"; test_cmd="$3"; hint="${4:-}"; after="${5:-0}"
  start=$(date +%s); i=0
  while :; do
    if eval "$test_cmd" >/dev/null 2>&1; then printf "${CL}${C_DIM}%s${C_OFF}  ${C_GREEN}%s${C_OFF} %s\n" "$BAR" "$OK" "$text"; return 0; fi
    elapsed=$(( $(date +%s) - start ))
    if [ $elapsed -ge "$limit" ]; then printf "${CL}${C_DIM}%s${C_OFF}  ${C_RED}%s %s${C_OFF}\n" "$BAR" "$ERR" "$text"; return 1; fi
    extra=''; [ -n "$hint" ] && [ $elapsed -ge "$after" ] && extra="  $hint"
    if [ "$SPIN" = '|/-\' ]; then s=$(printf '%s' "$SPIN" | cut -c $(( i % 4 + 1 ))); else s=$(printf '%s' "$SPIN" | cut -c $(( (i % 10) * 3 + 1 ))-$(( (i % 10) * 3 + 3 ))); fi
    printf "${CL}${C_DIM}%s${C_OFF}  ${C_YELLOW}%s %s%s (%s s)${C_OFF}" "$BAR" "$s" "$text" "$extra" "$elapsed"
    i=$((i + 1)); sleep 0.5
  done
}

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# install_archive <name> <url> <dest> <label>
install_archive() {
  tmp="${TMPDIR:-/tmp}/emuly-$1"
  printf "${C_DIM}%s${C_OFF}  %s\n" "$BAR" "$4"
  curl -fL --progress-bar -o "$tmp" "$2" || halt "The download of $1 failed."
  printf "${UP}${CL}"
  [ "$(sha256 "$tmp")" = "$(sum_for "$1")" ] || { rm -f "$tmp"; halt "The download of $1 failed its checksum. Nothing was installed."; }
  rm -rf "$3"; mkdir -p "$3"
  case "$1" in *.zip) unzip -q "$tmp" -d "$3" ;; *) tar -xzf "$tmp" -C "$3" ;; esac || halt "Could not unpack $1."
  rm -f "$tmp"
}
find_exe() { find "$1" -type f -name "$2" 2>/dev/null | head -n 1; }

# A port is open when curl connects to it. time_connect stays 0 when nothing listens. curl is on every Mac and most Linux.
port_open() {
  c=$(curl -s -o /dev/null --max-time 1 -w '%{time_connect}' "telnet://127.0.0.1:$1" </dev/null 2>/dev/null)
  case "$c" in ''|0|0.0*|0,0*) [ "${c#0[.,]}" != "$c" ] && [ -n "$(echo "${c#0[.,]}" | tr -d 0)" ] ;; *) true ;; esac
}

WINDOW_PID=''; TUNNEL_PID=''; SERIAL=''; ADB=''; ERRLOG=''; SAVED_TOKEN="${GH_TOKEN:-}"
cleanup() {
  [ -n "$WINDOW_PID" ] && kill "$WINDOW_PID" 2>/dev/null
  [ -n "$SERIAL" ] && [ -n "$ADB" ] && "$ADB" disconnect "$SERIAL" >/dev/null 2>&1
  if [ -n "$TUNNEL_PID" ]; then
    kill "$TUNNEL_PID" 2>/dev/null
    # gh starts ssh as a child. Stop it too, so the port closes.
    pkill -f "L $PORT:127.0.0.1:5555" 2>/dev/null
  fi
  [ -n "$ERRLOG" ] && rm -f "$ERRLOG"
  [ -n "$TTY" ] && printf '\033[?25h' >"$TTY"
}
trap cleanup EXIT
trap 'echo; exit 130' INT TERM

echo
printf "${C_CYAN}%s  Emuly${C_OFF} ${C_BOLD}%s${C_OFF}\n" "$ASK" "$PHONE"
line

OS=$(uname -s); ARCH=$(uname -m)
case "$ARCH" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=amd64 ;; *) halt "This computer type ($ARCH) is not supported." ;; esac

if [ $UNINSTALL -eq 1 ]; then
  step 'Remove Emuly tools'
  if [ -d "$TOOLS" ]; then rm -rf "$TOOLS"; ok "Removed $TOOLS"; else ok 'Nothing to remove'; fi
  done_ 'Done.'; exit 0
fi

# ---------- Tools ----------
step 'Tools'
MISSING=''
GH=$(command -v gh 2>/dev/null || true)
[ -z "$GH" ] && GH=$(find_exe "$TOOLS/gh-$GH_VERSION" gh)
if [ -n "$GH" ]; then ok "gh $("$GH" --version | head -n 1 | awk '{print $3}')"; else warn 'gh (GitHub CLI) is not installed'; MISSING="$MISSING gh"; fi

# A scrcpy on PATH works if it is 3.0 or newer. Else use the Emuly copy, which has its own adb.
SCRCPY=''
if command -v scrcpy >/dev/null 2>&1; then
  v=$(scrcpy --version 2>/dev/null | head -n 1 | awk '{print $2}')
  case "$v" in [3-9].*|[1-9][0-9].*) SCRCPY=$(command -v scrcpy); ADB=$(command -v adb 2>/dev/null || true) ;; esac
  [ -n "$SCRCPY" ] && [ -z "$ADB" ] && SCRCPY=''
fi
if [ -z "$SCRCPY" ]; then
  SCRCPY=$(find_exe "$TOOLS/scrcpy-$SCRCPY_VERSION" scrcpy)
  [ -n "$SCRCPY" ] && ADB="$(dirname "$SCRCPY")/adb"
fi
if [ -n "$SCRCPY" ]; then ok "scrcpy $("$SCRCPY" --version 2>/dev/null | head -n 1 | awk '{print $2}') (with adb)"; else warn 'scrcpy is not installed (it includes adb)'; MISSING="$MISSING scrcpy"; fi
line

if [ -n "$MISSING" ]; then
  [ $NO_INSTALL -eq 1 ] && halt "Missing:$MISSING. --no-install is set, so nothing was installed."
  # Linux on ARM has no official scrcpy build: offer the package manager, which needs admin.
  if [ "$OS" = Linux ] && [ "$ARCH" = arm64 ] && echo "$MISSING" | grep -q scrcpy; then
    PM=''
    for p in apt-get dnf pacman zypper; do command -v $p >/dev/null 2>&1 && { PM=$p; break; }; done
    [ -z "$PM" ] && halt 'scrcpy has no build for Linux on ARM. Install scrcpy 3 or newer, then run this again.'
    confirm "scrcpy has no portable build for Linux on ARM. Install it with $PM? It asks for your password (sudo)." || halt "Nothing was installed. The page still works: $PAGE_URL"
    case $PM in
      apt-get) sudo apt-get install -y scrcpy adb ;;
      dnf) sudo dnf install -y scrcpy android-tools ;;
      pacman) sudo pacman -S --noconfirm scrcpy android-tools ;;
      zypper) sudo zypper install -y scrcpy android-tools ;;
    esac || halt "$PM could not install scrcpy."
    SCRCPY=$(command -v scrcpy); ADB=$(command -v adb)
    MISSING=$(echo "$MISSING" | sed 's/ scrcpy//')
  fi
fi
if [ -n "$MISSING" ]; then
  what=''
  for m in $MISSING; do
    [ -n "$what" ] && what="$what and "
    if [ "$m" = gh ]; then what="${what}gh (GitHub CLI)"; else what="${what}scrcpy + adb"; fi
  done
  confirm "Install $what now? It goes in your user folder. No admin needed." || halt "Nothing was installed. The page still works: $PAGE_URL"
  line
  step 'Install'
  for m in $MISSING; do
    if [ "$m" = gh ]; then
      if [ "$OS" = Darwin ]; then name="gh_${GH_VERSION}_macOS_$ARCH.zip"; else name="gh_${GH_VERSION}_linux_$ARCH.tar.gz"; fi
      install_archive "$name" "https://github.com/cli/cli/releases/download/v$GH_VERSION/$name" "$TOOLS/gh-$GH_VERSION" "Downloading gh $GH_VERSION"
      GH=$(find_exe "$TOOLS/gh-$GH_VERSION" gh); chmod +x "$GH"
      ok "gh $GH_VERSION  (checksum verified)"
    else
      if [ "$OS" = Darwin ]; then
        if [ "$ARCH" = arm64 ]; then name="scrcpy-macos-aarch64-v$SCRCPY_VERSION.tar.gz"; else name="scrcpy-macos-x86_64-v$SCRCPY_VERSION.tar.gz"; fi
      else name="scrcpy-linux-x86_64-v$SCRCPY_VERSION.tar.gz"; fi
      install_archive "$name" "https://github.com/Genymobile/scrcpy/releases/download/v$SCRCPY_VERSION/$name" "$TOOLS/scrcpy-$SCRCPY_VERSION" "Downloading scrcpy $SCRCPY_VERSION"
      SCRCPY=$(find_exe "$TOOLS/scrcpy-$SCRCPY_VERSION" scrcpy); ADB="$(dirname "$SCRCPY")/adb"
      chmod +x "$SCRCPY" "$ADB"
      ok "scrcpy $SCRCPY_VERSION with adb  (checksum verified)"
    fi
  done
  line
fi

# ---------- GitHub accounts ----------
step 'Find the phone'
unset GH_TOKEN
accounts() { "$GH" auth status --hostname github.com 2>&1 | sed -n 's/.*account \([^ ]*\).*/\1/p; s/.*Logged in to github.com as \([^ ]*\).*/\1/p' | awk '!seen[$0]++'; }
JQ=".[] | select(.displayName == \"$PHONE\" or (.name | startswith(\"$PHONE-\"))) | \"\\(.name) \\(.state)\""

SPACE=''; STATE=''; TOKEN=''
while [ -z "$SPACE" ]; do
  list=$(accounts)
  [ -n "$ACCOUNT" ] && list=$(echo "$list" | grep -x "$ACCOUNT")
  if [ -z "$list" ]; then
    warn 'gh is not signed in to GitHub'
    confirm 'Sign in now? Your browser opens. Emuly never sees your GitHub token.' || halt 'Not signed in.'
    "$GH" auth login --hostname github.com --git-protocol https --web --scopes codespace </dev/tty
    line; continue
  fi
  found=''; noscope=''; nfound=0
  for a in $list; do
    t=$("$GH" auth token --hostname github.com --user "$a" 2>/dev/null || "$GH" auth token --hostname github.com 2>/dev/null)
    [ -z "$t" ] && { warn "$a: no token"; continue; }
    out=$(GH_TOKEN="$t" "$GH" codespace list --limit 100 --json name,displayName,state --jq "$JQ" 2>&1)
    if [ $? -ne 0 ]; then
      case "$out" in *codespace*scope*|*403*|*scope*codespace*) noscope="$noscope $a" ;; *) warn "$a: $(echo "$out" | tail -n 1)" ;; esac
      continue
    fi
    hit=$(echo "$out" | head -n 1)
    [ -n "$hit" ] && { found="$found$a $hit
"; nfound=$((nfound + 1)); }
  done
  if [ $nfound -eq 1 ]; then pick=$(echo "$found" | head -n 1)
  elif [ $nfound -gt 1 ]; then
    # shellcheck disable=SC2046
    set -- $(echo "$found" | awk 'NF {print $1}')
    choose 'The phone name is on more than one account. Which one?' "$@"
    pick=$(echo "$found" | awk 'NF' | sed -n "$((CHOICE + 1))p")
  else pick=''; fi
  if [ -n "$pick" ]; then
    who=$(echo "$pick" | awk '{print $1}'); SPACE=$(echo "$pick" | awk '{print $2}'); STATE=$(echo "$pick" | awk '{print $3}')
    TOKEN=$("$GH" auth token --hostname github.com --user "$who" 2>/dev/null || "$GH" auth token --hostname github.com)
    ok "Found on account $who"; break
  fi
  set --
  for a in $noscope; do set -- "$@" "Give gh the codespace permission for $a"; done
  set -- "$@" 'Sign in to another GitHub account' 'Stop'
  choose "The phone is not on $(echo $list | tr ' ' ',' | sed 's/,/, /g'). What next?" "$@"
  n=0; target=''
  for a in $noscope; do [ $n -eq $CHOICE ] && target=$a; n=$((n + 1)); done
  if [ -n "$target" ]; then
    active=$(accounts | head -n 1)
    "$GH" auth switch --hostname github.com --user "$target" >/dev/null 2>&1
    "$GH" auth refresh --hostname github.com --scopes codespace </dev/tty
    [ -n "$active" ] && [ "$active" != "$target" ] && "$GH" auth switch --hostname github.com --user "$active" >/dev/null 2>&1
  elif [ $CHOICE -eq $n ]; then
    "$GH" auth login --hostname github.com --git-protocol https --web --scopes codespace </dev/tty
  else halt 'Stopped.'; fi
  line
done
export GH_TOKEN="$TOKEN"

if [ "$STATE" != Available ]; then
  warn "The phone is asleep ($STATE). Wake it on the page:"
  line "$PAGE_URL"
  if [ "$OS" = Darwin ]; then open "$PAGE_URL" 2>/dev/null; else xdg-open "$PAGE_URL" >/dev/null 2>&1 & fi
  awake() { s=$("$GH" codespace list --limit 100 --json name,state --jq ".[] | select(.name == \"$SPACE\") | .state" 2>/dev/null); [ "$s" = Available ] || { sleep 4; return 1; }; }
  wait_until 'Waiting for the phone to wake' 300 awake || halt 'The phone did not wake in 5 min. Wake it on the page, then run this again.'
fi
line

# ---------- Tunnel ----------
step 'Connect'
[ -z "$PORT" ] && PORT=5555
tries=0
while port_open "$PORT"; do PORT=$((PORT + 1)); tries=$((tries + 1)); [ $tries -gt 50 ] && halt 'No free local port near 5555.'; done
SERIAL="127.0.0.1:$PORT"
ERRLOG="${TMPDIR:-/tmp}/emuly-tunnel-$PORT.log"
ready=1; attempt=1
while [ $attempt -le 3 ]; do
  "$GH" codespace ssh -c "$SPACE" -- -N -o LogLevel=ERROR -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
    -L "$PORT:127.0.0.1:5555" </dev/null >/dev/null 2>"$ERRLOG" &
  TUNNEL_PID=$!
  tunnel_up() { kill -0 "$TUNNEL_PID" 2>/dev/null || return 0; port_open "$PORT"; }
  wait_until "Secure tunnel on port $PORT" 90 tunnel_up 'first time: gh sets up an SSH key' 8
  if kill -0 "$TUNNEL_PID" 2>/dev/null; then ready=0; break; fi
  fail "The tunnel closed: $(grep -v -e 'store now' -e 'decrypt later' -e 'openssh.com/pq' "$ERRLOG" | tail -n 1)"
  attempt=$((attempt + 1))
  [ $attempt -le 3 ] && line "Trying again ($attempt of 3)"
done
[ $ready -eq 0 ] || halt "The tunnel did not open. The page still works: $PAGE_URL"

# ---------- adb ----------
export ADB
"$ADB" connect "$SERIAL" >/dev/null 2>&1
android_ready() {
  [ "$("$ADB" -s "$SERIAL" get-state 2>/dev/null)" = device ] || { "$ADB" connect "$SERIAL" >/dev/null 2>&1; return 1; }
  [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]
}
wait_until 'Android is ready' 180 android_ready 'Android is still starting' 5 || halt "Android did not answer. Check the phone on the page: $PAGE_URL"
line

# ---------- scrcpy ----------
step 'Open the window'
# Place the window like a phone at the right edge: 85% of the screen height, top-right corner. Best effort.
PLACE=''
size=$("$ADB" -s "$SERIAL" shell wm size 2>/dev/null | tr -d '\r' | tail -n 1 | sed 's/.*: //')
dw=${size%x*}; dh=${size#*x}
case "$dw$dh" in ''|*[!0-9]*) dw=1080; dh=2400 ;; esac
screen=''
if [ "$OS" = Darwin ]; then
  screen=$(osascript -e 'tell application "Finder" to get bounds of window of desktop' 2>/dev/null | awk -F', ' '{print $3"x"$4}')
elif [ -n "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ] && command -v xdpyinfo >/dev/null 2>&1; then
  screen=$(xdpyinfo | awk '/dimensions:/ {print $2; exit}')
fi
if [ -n "$screen" ]; then
  sw=${screen%x*}; sh_=${screen#*x}
  wh=$((sh_ * 85 / 100)); ww=$((wh * dw / dh))
  PLACE="--window-x=$((sw - ww - 24)) --window-y=$((sh_ * 5 / 100)) --window-width=$ww --window-height=$wh"
fi
SCLOG="${TMPDIR:-/tmp}/emuly-scrcpy-$PORT.log"
# shellcheck disable=SC2086
"$SCRCPY" -s "$SERIAL" --window-title "Emuly - $PHONE" --stay-awake $PLACE </dev/null >"$SCLOG" 2>&1 &
WINDOW_PID=$!
sleep 2
kill -0 $WINDOW_PID 2>/dev/null || halt "scrcpy closed at once. $(grep ERROR "$SCLOG" | tail -n 1)"
ok "The phone is open in the 'Emuly - $PHONE' window"
line
done_ 'Close the window or press Ctrl+C here to end. Keyboard and clipboard work in the window.'
# A tunnel alone may not count as use for GitHub. Run a short command each minute while the window is open.
# Emuly still stops the phone when Android sees no touch or key for its idle time.
ticks=0
while kill -0 $WINDOW_PID 2>/dev/null; do
  kill -0 "$TUNNEL_PID" 2>/dev/null || { fail 'The tunnel closed. The phone may have gone to sleep.'; kill $WINDOW_PID 2>/dev/null; break; }
  ticks=$((ticks + 1))
  if [ $ticks -ge 60 ]; then ticks=0; "$GH" codespace ssh -c "$SPACE" -- echo emuly-awake </dev/null >/dev/null 2>&1 & fi
  sleep 1
done
rm -f "$SCLOG"
echo
printf "${C_DIM}Closed.${C_OFF}\n"
