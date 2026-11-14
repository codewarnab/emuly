# Linux commands

Commands for each playbook topic, for `bash` and `curl`. They work the same on a desktop and
on a remote machine reached over SSH or Tailscale. Each new shell must read the key first:

~~~bash
base="{{EMULY_BASE_URL}}"
key="${EMULY_KEY:-$(cat ~/.config/emuly/key 2>/dev/null)}"
auth="Authorization: Bearer $key"
~~~

Optional installs come from the system package manager (`apt`, `dnf`, `pacman`) and may need
`sudo`: ask first, and never type a password for the user. On a remote machine, read
`references/remote.md` first: scrcpy runs on the user's computer, not here.

- scrcpy (includes adb): `sudo apt install scrcpy`, or the release at
  https://github.com/Genymobile/scrcpy/blob/master/doc/linux.md when the package is old.
- GitHub CLI (native adb only): https://github.com/cli/cli/blob/trunk/docs/install_linux.md

## List, start, create and stop

~~~bash
curl -sS -H "$auth" "$base/v1/phones"
~~~

~~~bash
id="phone-quiet-falcon"
curl -sS -X POST "$base/v1/phones/$id/start" -H "$auth"
curl -sS -H "$auth" "$base/v1/phones/$id"
~~~

~~~bash
response=$(curl -sS -X POST "$base/v1/phones" -H "$auth" -H "content-type: application/json" --data '{"idle_timeout_min":240}')
id=$(printf '%s' "$response" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
printf '%s\n' "$base/app/phones/$id"
~~~

~~~bash
curl -sS -X POST "$base/v1/phones/$id/stop" -H "$auth"
~~~

## adb calls

Wrapper (define it once, then call it with a JSON array):

~~~bash
emulyadb() { curl -sS -X POST "$base/v1/phones/$id/adb" -H "$auth" -H "content-type: application/json" --data "{\"args\":$1}"; }
~~~

Call it with any argument array from `references/adb.md`:

~~~bash
emulyadb '["shell","input","tap","540","1200"]'
~~~

Save a screenshot:

~~~bash
curl -sS -X POST "$base/v1/phones/$id/adb" -H "$auth" -H "content-type: application/json" --data '{"args":["exec-out","screencap","-p"]}' -o "$scratch/emuly-$id-screen.png"   # scratch: a temp folder, never the repo
~~~

## Files, installs and downloads

Helper:

~~~bash
emulyadbfile() {
  local json="$1"; shift
  local timeout="${EMULY_ADB_TIMEOUT:-30}"
  local call=(-sS -X POST "$base/v1/phones/$id/adb" -H "$auth" -F "args=$json" -F "timeout_s=$timeout")
  local i=0
  for file in "$@"; do call+=(-F "file$i=@$file"); i=$((i + 1)); done
  curl "${call[@]}"
}
~~~

Install an APK. The only install flags are `-r`, `-t`, `-g`, `-d` and `--abi`:

~~~bash
EMULY_ADB_TIMEOUT=300 emulyadbfile '["install","-r","@file0"]' "$HOME/app.apk"
EMULY_ADB_TIMEOUT=300 emulyadbfile '["install-multiple","-r","@file0","@file1"]' "$HOME/base.apk" "$HOME/split.apk"
~~~

Push one file. The device path must be under `/sdcard/` or `/data/local/tmp/`, with no `..`:

~~~bash
emulyadbfile '["push","@file0","/sdcard/Download/x.txt"]' "$HOME/x.txt"
~~~

Pull a device file into a laptop path, or download a bugreport. Both stream bytes with a
`Content-Disposition` filename:

~~~bash
curl -sS -X POST "$base/v1/phones/$id/adb" -H "$auth" -F 'args=["pull","/sdcard/x.png"]' -o "$HOME/x.png"
curl -sS -X POST "$base/v1/phones/$id/adb" -H "$auth" -F 'args=["bugreport"]' -F 'timeout_s=300' -o "$HOME/bugreport.zip"
~~~

## Apps endpoint

A direct HTTPS URL is the easiest:

~~~bash
uuid=$(cat /proc/sys/kernel/random/uuid)
curl -sS -X POST "$base/v1/phones/$id/app-installs" -H "$auth" -H "content-type: application/json" \
  --data "{\"source\":\"url\",\"key\":\"$uuid\",\"url\":\"https://example.com/app.apk\"}"
curl -sS -H "$auth" "$base/v1/phones/$id/app-installs/<operation-id>"
~~~

For a local file, create an `upload` operation, then send 4 MiB chunks with
`PUT /v1/phones/<id>/app-installs/<operation-id>/content`. Each chunk needs
`content-type: application/octet-stream`, `x-upload-offset` and `x-chunk-sha256`
(lowercase SHA-256 of that chunk). Finish with
`POST /v1/phones/<id>/app-installs/<operation-id>/complete`, then poll the operation
until its `stage` is `succeeded`, `failed`, `cancelled` or `interrupted`.

~~~bash
file="$HOME/app.apk"
opkey=$(cat /proc/sys/kernel/random/uuid)
total=$(stat -c %s "$file")
op=$(curl -sS -X POST "$base/v1/phones/$id/app-installs" -H "$auth" -H "content-type: application/json" \
  --data "{\"source\":\"upload\",\"key\":\"$opkey\",\"filename\":\"$(basename "$file")\",\"totalBytes\":$total}")
opid=$(printf '%s' "$op" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
offset=0
while [ "$offset" -lt "$total" ]; do
  chunk=$(mktemp)
  dd if="$file" of="$chunk" bs=4194304 skip=$((offset / 4194304)) count=1 status=none
  sha=$(sha256sum "$chunk" | cut -d' ' -f1)
  curl -sS -X PUT "$base/v1/phones/$id/app-installs/$opid/content" -H "$auth" \
    -H "content-type: application/octet-stream" -H "x-upload-offset: $offset" -H "x-chunk-sha256: $sha" \
    --data-binary "@$chunk"
  offset=$((offset + $(stat -c %s "$chunk")))
  rm -f "$chunk"
done
curl -sS -X POST "$base/v1/phones/$id/app-installs/$opid/complete" -H "$auth"
curl -sS -H "$auth" "$base/v1/phones/$id/app-installs/$opid"
~~~

Open an installed app and read the inventory:

~~~bash
curl -sS -H "$auth" "$base/v1/phones/$id/apps"
curl -sS -X POST "$base/v1/phones/$id/apps/open" -H "$auth" -H "content-type: application/json" --data '{"packageId":"com.example.app"}'
~~~

## Usage

~~~bash
curl -sS -H "$auth" "$base/v1/usage"
~~~

## Delete a phone

~~~bash
tmp=$(mktemp)
deleted=$(curl -sS -o "$tmp" -w '%{http_code}' -X DELETE "$base/v1/phones/$id" -H "$auth")
if [ "$deleted" = "200" ]; then
  settings=$(sed -n 's/.*"settings_url":"\([^"]*\)".*/\1/p' "$tmp")
  printf 'I deleted %s. To require approval again, turn off '\''Let agents delete phones without asking'\'' at %s.\n' "$name" "$settings"
else
  page=$(sed -n 's/.*"manage_url":"\([^"]*\)".*/\1/p' "$tmp")
  [ -z "$page" ] || printf 'The browser page is %s.\n' "$page"
  status=$(curl -sS -X POST "$base/v1/phones/$id/delete-requests" -H "$auth")
  request_id=$(printf '%s' "$status" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
  approve=$(printf '%s' "$status" | sed -n 's/.*"approve_url":"\([^"]*\)".*/\1/p')
  printf 'Approve this deletion: %s\n' "$approve"
  waited=0
  while [ "$waited" -lt 600 ]; do
    result=$(curl -sS -m 40 -H "$auth" "$base/v1/phones/$id/delete-requests/$request_id?wait=25")
    waited=$((waited + 25))
    state=$(printf '%s' "$result" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
    if [ "$state" = "done" ]; then printf 'I deleted %s.\n' "$name"; break; fi
    if [ "$state" = "denied" ]; then printf 'The user kept %s.\n' "$name"; break; fi
    if [ "$state" = "expired" ]; then printf 'The request expired. Ask again if needed.\n'; break; fi
  done
fi
~~~

## Webhooks

~~~bash
curl -sS -X POST "$base/v1/webhooks" -H "$auth" -H "content-type: application/json" --data '{"url":"https://example.com/emuly","events":"*"}'
curl -sS -H "$auth" "$base/v1/webhooks"
~~~
