# Linux key setup

These are the Linux commands for the key setup. They work the same on a desktop and on a
remote machine that the user reaches over SSH or Tailscale. Use `bash` and `curl`.

## Where the key lives

Linux has no user variable that every new shell reads, so the key lives in one file that
only the user can read:

- File: `~/.config/emuly/key` (folder mode 700, file mode 600).
- `EMULY_KEY` in the environment wins over the file when it is set.
- Never put the key in the user's repository, in a shell rc file, or in the chat.

Read it at the start of every shell:

~~~bash
base="{{EMULY_BASE_URL}}"
key="${EMULY_KEY:-$(cat ~/.config/emuly/key 2>/dev/null)}"
~~~

The `save`, `read` and `clear` commands in the token response are for Windows (`setx`).
On Linux, ignore them and use these instead:

~~~bash
mkdir -p ~/.config/emuly && chmod 700 ~/.config/emuly
( umask 077 && printf '%s' "$key" > ~/.config/emuly/key )
~~~

Clear it after a **401**: `rm -f ~/.config/emuly/key`.

Optional installs come from the system package manager (`apt`, `dnf`, `pacman`) or the
user's version manager. They may need `sudo`: ask before you run one, and never type a
password for the user. On a remote machine, scrcpy is not needed there (see the skill).

Replace `<agent name>` with your agent name, for example `Claude Code`.

## A1. Exchange a setup code

~~~bash
base="{{EMULY_BASE_URL}}"
key="${EMULY_KEY:-$(cat ~/.config/emuly/key 2>/dev/null)}"
if [ -z "$key" ]; then
  code="emuly_sc_..."               # the setup code from the prompt
  response=$(curl -sS -X POST "$base/v1/agent/token" -H "content-type: application/json" \
    --data "{\"code\":\"$code\",\"name\":\"<agent name> on $(hostname)\"}")
  key=$(printf '%s' "$response" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
  unset response
  mkdir -p ~/.config/emuly && chmod 700 ~/.config/emuly
  ( umask 077 && printf '%s' "$key" > ~/.config/emuly/key )
fi
auth="Authorization: Bearer $key"
~~~

## A2. Device sign-in flow

On a remote machine the user opens the link on the computer in front of them, not on this
machine. Say so in the line you show: "Open this on your own computer and approve: <link>".

~~~bash
base="{{EMULY_BASE_URL}}"
key="${EMULY_KEY:-$(cat ~/.config/emuly/key 2>/dev/null)}"
if [ -z "$key" ]; then
  start=$(curl -sS -X POST "$base/v1/agent/device")
  device=$(printf '%s' "$start" | sed -n 's/.*"device_code":"\([^"]*\)".*/\1/p')
  link=$(printf '%s' "$start" | sed -n 's/.*"verification_uri_complete":"\([^"]*\)".*/\1/p')
  interval=$(printf '%s' "$start" | sed -n 's/.*"interval":\([0-9]*\).*/\1/p')
  expires=$(printf '%s' "$start" | sed -n 's/.*"expires_in":\([0-9]*\).*/\1/p')
  printf 'Approve this sign-in: %s\n' "$link"
  waited=0
  while [ "$waited" -lt "$expires" ]; do
    sleep "$interval"
    waited=$((waited + interval))
    response=$(curl -sS -X POST "$base/v1/agent/device/token" -H "content-type: application/json" \
      --data "{\"device_code\":\"$device\"}")
    error=$(printf '%s' "$response" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')
    if [ -z "$error" ]; then
      key=$(printf '%s' "$response" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
      unset response
      mkdir -p ~/.config/emuly && chmod 700 ~/.config/emuly
      ( umask 077 && printf '%s' "$key" > ~/.config/emuly/key )
      break
    fi
    if [ "$error" = "authorization_pending" ]; then continue; fi
    if [ "$error" = "slow_down" ]; then sleep 5; waited=$((waited + 5)); continue; fi
    if [ "$error" = "access_denied" ]; then echo "Sign-in was denied. Stop here."; break; fi
    if [ "$error" = "expired_token" ]; then echo "The link expired. Ask the user to click Copy prompt again."; break; fi
    echo "Sign-in failed: $error"
    break
  done
fi
auth="Authorization: Bearer $key"
~~~
