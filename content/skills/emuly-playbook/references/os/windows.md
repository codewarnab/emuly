# Windows commands

Commands for each playbook topic. Each new shell must read the key first:

~~~powershell
$base = "{{EMULY_BASE_URL}}"
$key = [Environment]::GetEnvironmentVariable('EMULY_KEY','User')
$headers = @{ Authorization = "Bearer $key" }
~~~

~~~bash
base="{{EMULY_BASE_URL}}"
key=$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('EMULY_KEY','User')" | tr -d '\r')
auth="Authorization: Bearer $key"
~~~

Use PowerShell `Invoke-RestMethod`, or Git Bash with `curl.exe` (not the `curl` alias).
Optional installs come only from `winget`: `Genymobile.scrcpy` and `GitHub.cli` (native adb only).

## List, start, create and stop

~~~powershell
$phones = Invoke-RestMethod -Uri "$base/v1/phones" -Headers $headers
$phones.phones | Format-Table id, name, state, android_state, idle_timeout_min, browser_url
~~~

~~~bash
curl.exe -sS -H "$auth" "$base/v1/phones"
~~~

~~~powershell
$id = "phone-quiet-falcon"           # the id from the list
Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$id/start" -Headers $headers
Invoke-RestMethod -Uri "$base/v1/phones/$id" -Headers $headers
~~~

~~~bash
id="phone-quiet-falcon"
curl.exe -sS -X POST "$base/v1/phones/$id/start" -H "$auth"
curl.exe -sS -H "$auth" "$base/v1/phones/$id"
~~~

~~~powershell
$phone = Invoke-RestMethod -Method Post -Uri "$base/v1/phones" -Headers $headers -ContentType "application/json" -Body '{"idle_timeout_min":240}'
$phoneLink = "$base/app/phones/$($phone.id)"
Write-Output $phoneLink
~~~

~~~bash
response=$(curl.exe -sS -X POST "$base/v1/phones" -H "$auth" -H "content-type: application/json" --data '{"idle_timeout_min":240}')
id=$(printf '%s' "$response" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
printf '%s\n' "$base/app/phones/$id"
~~~

~~~powershell
Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$id/stop" -Headers $headers
~~~

~~~bash
curl.exe -sS -X POST "$base/v1/phones/$id/stop" -H "$auth"
~~~

## adb calls

PowerShell wrapper (define it once, then call it with a JSON array):

~~~powershell
function EmulyAdb([string]$json) { Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$id/adb" -Headers $headers -ContentType "application/json" -Body "{`"args`":$json}" }
~~~

Git Bash wrapper (define it once, then call it with a JSON array):

~~~bash
emulyadb() { curl.exe -sS -X POST "$base/v1/phones/$id/adb" -H "$auth" -H "content-type: application/json" --data "{\"args\":$1}"; }
~~~

Call it with any argument array from `references/adb.md`:

~~~powershell
EmulyAdb '["shell","input","tap","540","1200"]'
~~~

~~~bash
emulyadb '["shell","input","tap","540","1200"]'
~~~

Save a screenshot:

~~~powershell
Invoke-WebRequest -Method Post -Uri "$base/v1/phones/$id/adb" -Headers $headers -ContentType "application/json" -Body '{"args":["exec-out","screencap","-p"]}' -OutFile screen.png
~~~

~~~bash
curl.exe -sS -X POST "$base/v1/phones/$id/adb" -H "$auth" -H "content-type: application/json" --data '{"args":["exec-out","screencap","-p"]}' -o screen.png
~~~

## Files, installs and downloads

PowerShell helper (uses `curl.exe`, not the `curl` alias):

~~~powershell
function EmulyAdbFile([string]$json, [string[]]$files, [int]$timeout = 30) {
  $call = @("-sS","-X","POST","$base/v1/phones/$id/adb","-H","Authorization: Bearer $key",
    "-F","args=$json","-F","timeout_s=$timeout")
  for ($i = 0; $i -lt $files.Count; $i++) { $call += @("-F", "file$i=@$($files[$i])") }
  & curl.exe @call
}
~~~

Git Bash helper:

~~~bash
emulyadbfile() {
  local json="$1"; shift
  local timeout="${EMULY_ADB_TIMEOUT:-30}"
  local call=(-sS -X POST "$base/v1/phones/$id/adb" -H "$auth" -F "args=$json" -F "timeout_s=$timeout")
  local i=0
  for file in "$@"; do call+=(-F "file$i=@$file"); i=$((i + 1)); done
  curl.exe "${call[@]}"
}
~~~

Install an APK. The only install flags are `-r`, `-t`, `-g`, `-d` and `--abi`:

~~~powershell
EmulyAdbFile '["install","-r","@file0"]' @("C:\Users\me\app.apk") 300
EmulyAdbFile '["install-multiple","-r","@file0","@file1"]' @("C:\Users\me\base.apk","C:\Users\me\split.apk") 300
~~~

~~~bash
EMULY_ADB_TIMEOUT=300 emulyadbfile '["install","-r","@file0"]' "/c/Users/me/app.apk"
EMULY_ADB_TIMEOUT=300 emulyadbfile '["install-multiple","-r","@file0","@file1"]' "/c/Users/me/base.apk" "/c/Users/me/split.apk"
~~~

Push one file. The device path must be under `/sdcard/` or `/data/local/tmp/`, with no `..`:

~~~powershell
EmulyAdbFile '["push","@file0","/sdcard/Download/x.txt"]' @("C:\Users\me\x.txt")
~~~

~~~bash
emulyadbfile '["push","@file0","/sdcard/Download/x.txt"]' "/c/Users/me/x.txt"
~~~

Pull a device file into a laptop path, or download a bugreport. Both stream bytes with a
`Content-Disposition` filename:

~~~powershell
curl.exe -sS -X POST "$base/v1/phones/$id/adb" -H "Authorization: Bearer $key" -F 'args=["pull","/sdcard/x.png"]' -o "C:\Users\me\x.png"
curl.exe -sS -X POST "$base/v1/phones/$id/adb" -H "Authorization: Bearer $key" -F 'args=["bugreport"]' -F 'timeout_s=300' -o "C:\Users\me\bugreport.zip"
~~~

~~~bash
curl.exe -sS -X POST "$base/v1/phones/$id/adb" -H "$auth" -F 'args=["pull","/sdcard/x.png"]' -o "/c/Users/me/x.png"
curl.exe -sS -X POST "$base/v1/phones/$id/adb" -H "$auth" -F 'args=["bugreport"]' -F 'timeout_s=300' -o "/c/Users/me/bugreport.zip"
~~~

## Apps endpoint

A direct HTTPS URL is the easiest:

~~~powershell
$install = @{ source = "url"; key = [guid]::NewGuid().ToString(); url = "https://example.com/app.apk" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$id/app-installs" -Headers $headers -ContentType "application/json" -Body $install
Invoke-RestMethod -Uri "$base/v1/phones/$id/app-installs/<operation-id>" -Headers $headers
~~~

~~~bash
uuid=$(powershell.exe -NoProfile -Command "[guid]::NewGuid().ToString()" | tr -d '\r')
curl.exe -sS -X POST "$base/v1/phones/$id/app-installs" -H "$auth" -H "content-type: application/json" \
  --data "{\"source\":\"url\",\"key\":\"$uuid\",\"url\":\"https://example.com/app.apk\"}"
curl.exe -sS -H "$auth" "$base/v1/phones/$id/app-installs/<operation-id>"
~~~

For a local file, create an `upload` operation, then send 4 MiB chunks with
`PUT /v1/phones/<id>/app-installs/<operation-id>/content`. Each chunk needs
`content-type: application/octet-stream`, `x-upload-offset` and `x-chunk-sha256`
(lowercase SHA-256 of that chunk). Finish with
`POST /v1/phones/<id>/app-installs/<operation-id>/complete`, then poll the operation
until its `stage` is `succeeded`, `failed`, `cancelled` or `interrupted`.

~~~bash
file="/c/Users/me/app.apk"
key=$(powershell.exe -NoProfile -Command "[guid]::NewGuid().ToString()" | tr -d '\r')
total=$(stat -c %s "$file")
op=$(curl.exe -sS -X POST "$base/v1/phones/$id/app-installs" -H "$auth" -H "content-type: application/json" \
  --data "{\"source\":\"upload\",\"key\":\"$key\",\"filename\":\"$(basename "$file")\",\"totalBytes\":$total}")
opid=$(printf '%s' "$op" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
offset=0
while [ "$offset" -lt "$total" ]; do
  chunk=$(mktemp)
  dd if="$file" of="$chunk" bs=4194304 skip=$((offset / 4194304)) count=1 status=none
  sha=$(sha256sum "$chunk" | cut -d' ' -f1)
  curl.exe -sS -X PUT "$base/v1/phones/$id/app-installs/$opid/content" -H "$auth" \
    -H "content-type: application/octet-stream" -H "x-upload-offset: $offset" -H "x-chunk-sha256: $sha" \
    --data-binary "@$chunk"
  offset=$((offset + $(stat -c %s "$chunk")))
  rm -f "$chunk"
done
curl.exe -sS -X POST "$base/v1/phones/$id/app-installs/$opid/complete" -H "$auth"
curl.exe -sS -H "$auth" "$base/v1/phones/$id/app-installs/$opid"
~~~

Open an installed app and read the inventory:

~~~powershell
Invoke-RestMethod -Uri "$base/v1/phones/$id/apps" -Headers $headers
Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$id/apps/open" -Headers $headers -ContentType "application/json" -Body '{"packageId":"com.example.app"}'
~~~

~~~bash
curl.exe -sS -H "$auth" "$base/v1/phones/$id/apps"
curl.exe -sS -X POST "$base/v1/phones/$id/apps/open" -H "$auth" -H "content-type: application/json" --data '{"packageId":"com.example.app"}'
~~~

## Usage

~~~powershell
Invoke-RestMethod -Uri "$base/v1/usage" -Headers $headers
~~~

~~~bash
curl.exe -sS -H "$auth" "$base/v1/usage"
~~~

## Delete a phone

~~~powershell
try {
  $deleted = Invoke-RestMethod -Method Delete -Uri "$base/v1/phones/$id" -Headers $headers
  Write-Output "I deleted $($phone.name). To require approval again, turn off 'Let agents delete phones without asking' at $($deleted.settings_url)."
} catch {
  $status = $_.ErrorDetails.Message | ConvertFrom-Json
  if ($status.error -ne "forbidden") { throw }
  if ($status.manage_url) { Write-Output "The browser page is $($status.manage_url)." }
  $request = Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$id/delete-requests" -Headers $headers
  Write-Output "Approve this deletion: $($request.approve_url)"
  $deadline = (Get-Date).AddSeconds($request.expires_in)
  while ((Get-Date) -lt $deadline) {
    $result = Invoke-RestMethod -TimeoutSec 40 -Uri "$base/v1/phones/$id/delete-requests/$($request.request_id)?wait=25" -Headers $headers
    if ($result.status -eq "done") { Write-Output "I deleted $($phone.name)."; break }
    if ($result.status -eq "denied") { Write-Output "The user kept $($phone.name)."; break }
    if ($result.status -eq "expired") { Write-Output "The request expired. Ask again if needed."; break }
  }
}
~~~

~~~bash
deleted=$(curl.exe -sS -o /tmp/emuly-delete.json -w '%{http_code}' -X DELETE "$base/v1/phones/$id" -H "$auth")
if [ "$deleted" = "200" ]; then
  settings=$(sed -n 's/.*"settings_url":"\([^"]*\)".*/\1/p' /tmp/emuly-delete.json)
  printf 'I deleted %s. To require approval again, turn off '\''Let agents delete phones without asking'\'' at %s.\n' "$name" "$settings"
else
  page=$(sed -n 's/.*"manage_url":"\([^"]*\)".*/\1/p' /tmp/emuly-delete.json)
  [ -z "$page" ] || printf 'The browser page is %s.\n' "$page"
  status=$(curl.exe -sS -X POST "$base/v1/phones/$id/delete-requests" -H "$auth")
  request_id=$(printf '%s' "$status" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
  approve=$(printf '%s' "$status" | sed -n 's/.*"approve_url":"\([^"]*\)".*/\1/p')
  printf 'Approve this deletion: %s\n' "$approve"
  waited=0
  while [ "$waited" -lt 600 ]; do
    waited=$((waited + 25))
    result=$(curl.exe -sS -m 40 -H "$auth" "$base/v1/phones/$id/delete-requests/$request_id?wait=25")
    state=$(printf '%s' "$result" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
    if [ "$state" = "done" ]; then printf 'I deleted %s.\n' "$name"; break; fi
    if [ "$state" = "denied" ]; then printf 'The user kept %s.\n' "$name"; break; fi
    if [ "$state" = "expired" ]; then printf 'The request expired. Ask again if needed.\n'; break; fi
  done
fi
~~~

## Webhooks

~~~powershell
$hook = @{ url = "https://example.com/emuly"; events = "*" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/v1/webhooks" -Headers $headers -ContentType "application/json" -Body $hook
Invoke-RestMethod -Uri "$base/v1/webhooks" -Headers $headers
~~~

~~~bash
curl.exe -sS -X POST "$base/v1/webhooks" -H "$auth" -H "content-type: application/json" --data '{"url":"https://example.com/emuly","events":"*"}'
curl.exe -sS -H "$auth" "$base/v1/webhooks"
~~~
