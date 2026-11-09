/** Static, versioned runbook served at /agent.md. It documents only routes that exist under app/v1. */
export const AGENT_RUNBOOK_VERSION = "2026-11-09.3";

export function agentRunbook(osId?: string | null, agentId?: string | null) {
  const supported = osId === "windows" && agentId === "claude-code";
  const note = supported ? "" : [
    `> **Note:** This runbook is written for Windows + Claude Code.`,
    `> You asked for ${osId || "an unknown OS"} + ${agentId || "an unknown agent"}. The API rules are the same,`,
    `> but adapt the shell commands to that system. Do not install extra tooling just to match these examples.`,
    "",
  ].join("\n");
  return `${note}${BODY}`;
}

const BODY = `# Emuly agent runbook

Version: ${AGENT_RUNBOOK_VERSION}

You are setting up an Android phone for the user with Emuly. Emuly runs the phone in
the user's own GitHub Codespace, on the hours included in their GitHub plan. Never
ask the user to pay Emuly, and never claim Emuly bills them.

Three ways to drive the phone exist. Use the first one by default.

- **Option 2, default:** send ordinary \`adb\` arguments to Emuly's HTTP route. No install,
  no GitHub CLI. The codespace runner runs adb against the emulator for you.
- **Option 1, optional:** a real local \`adb\` or scrcpy connection over a
  \`gh codespace ssh\` tunnel. Use it only when the user asks for it.
- **Option 3, future:** a local relay helper for \`adb connect\`. It does not exist yet.
  Do not wait for it and do not invent an endpoint.

## Rules that do not change

- Never print, log, paste into chat, or send the agent key anywhere except Emuly.
- Send the key only in an \`Authorization: Bearer\` header to the Emuly base URL in the prompt.
- Do not use \`npm install\`, \`irm ... | iex\`, \`curl ... | sh\`, or any other remote script for Emuly.
  The only optional install in this runbook is scrcpy through \`winget\`.
- A 4-core phone uses 4 core-hours for every wall-clock hour. A 30-minute idle stop is
  best for short tasks. Choose 240 minutes (4 hours) only when the task really is long.
- Thinking or waiting without terminal or editor activity counts as idle to GitHub.
  Keep progress moving, or tell the user the phone may stop.
- Give the user a short progress update at each stage: key, list, create or start, boot,
  install, done.
- Do not create a second phone when a running or stopped phone can be reused.
- At the end, ask whether to stop the phone, then use \`POST /v1/phones/<id>/stop\`.
  Stopping keeps the phone and its apps.

## A. Get a key from the setup code

The prompt contains a setup code such as \`emuly_sc_...\`. It works once and expires in
one hour. Exchange it for a 90-day key. The response is the only time the raw key is shown.

PowerShell:

~~~powershell
$base = "https://your-emuly-host"   # the base URL from the prompt
$code = "emuly_sc_..."              # the setup code from the prompt
$body = @{ code = $code; name = "Claude Code on $env:COMPUTERNAME" } | ConvertTo-Json
$result = Invoke-RestMethod -Method Post -Uri "$base/v1/agent/token" -ContentType "application/json" -Body $body
$dir = Join-Path $env:USERPROFILE ".emuly"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Set-Content -NoNewline -Path (Join-Path $dir "key") -Value $result.key
~~~

Git Bash (also use \`curl.exe\`, not the \`curl\` alias):

~~~bash
base="https://your-emuly-host"
code="emuly_sc_..."
body="{\\"code\\":\\"$code\\",\\"name\\":\\"Claude Code on $HOSTNAME\\"}"
response=$(curl.exe -sS -X POST "$base/v1/agent/token" -H "content-type: application/json" --data "$body")
key=$(printf '%s' "$response" | sed -n 's/.*"key":"\\([^"]*\\)".*/\\1/p')
mkdir -p "$HOME/.emuly" && chmod 700 "$HOME/.emuly"
printf '%s' "$key" > "$HOME/.emuly/key" && chmod 600 "$HOME/.emuly/key"
unset key response body
~~~

On every later request, reuse the saved key first. Never exchange a second setup code
unless the user clicks **Copy prompt** again in the console.

~~~powershell
$base = "https://your-emuly-host"
$key = (Get-Content -Raw (Join-Path $env:USERPROFILE ".emuly\key")).Trim()
$headers = @{ Authorization = "Bearer $key" }
~~~

~~~bash
base="https://your-emuly-host"
key=$(cat "$HOME/.emuly/key")
auth="Authorization: Bearer $key"
~~~

If a request that uses the saved key returns **401**, the key is expired or revoked:

1. Delete the saved key.
   PowerShell: \`Remove-Item (Join-Path $env:USERPROFILE ".emuly\key") -Force\`
   Git Bash: \`rm -f "$HOME/.emuly/key"\`
2. Ask the user to click **Copy prompt** in the Emuly console and send you the new code.
3. Exchange the new code once. Do not reuse the old code.

## B. Choose and start the phone

List the user's phones before doing anything else. Each phone has an \`id\`, a friendly
\`name\`, \`state\`, \`android_state\`, \`idle_timeout_min\` and a \`browser_url\`.

~~~powershell
$phones = Invoke-RestMethod -Uri "$base/v1/phones" -Headers $headers
$phones.phones | Format-Table id, name, state, android_state, idle_timeout_min, browser_url
~~~

~~~bash
curl.exe -sS -H "$auth" "$base/v1/phones"
~~~

Use the first rule that fits:

1. **A phone is running with Android ready.** Reuse it. Read it with
   \`GET /v1/phones/<id>\` and print \`browser_url\`.
2. **A phone exists but is stopped.** Start it, then poll until Android is ready.
3. **No phone exists.** Create one, then poll until Android is ready.

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

A start returns **202** with \`{"id":"...","status":"starting"}\`. Poll \`GET /v1/phones/<id>\`
until \`state\` is \`running\` and \`android_state\` is \`ready\`. Booting can take several
minutes. Send a short progress line every 30-60 seconds while it boots. Do not create a
second phone while the first one is booting.

Create only when the list is empty (or the user explicitly asks for another phone):

~~~powershell
$phone = Invoke-RestMethod -Method Post -Uri "$base/v1/phones" -Headers $headers -ContentType "application/json" -Body '{"idle_timeout_min":240}'
$phoneLink = "$base/app/phones/$($phone.id)"
Write-Output $phoneLink
~~~

~~~bash
response=$(curl.exe -sS -X POST "$base/v1/phones" -H "$auth" -H "content-type: application/json" --data '{"idle_timeout_min":240}')
id=$(printf '%s' "$response" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
printf '%s\\n' "$base/app/phones/$id"
~~~

The browser link is the way to watch and touch the phone. Print every link as plain text
on its own line, never as a hidden or shortened link. The same link is in \`browser_url\`
from the list.

At the end, ask whether to stop the phone:

~~~powershell
Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$id/stop" -Headers $headers
~~~

~~~bash
curl.exe -sS -X POST "$base/v1/phones/$id/stop" -H "$auth"
~~~

## Control the phone with adb (default, option 2)

Send ordinary adb arguments as a JSON array to \`POST /v1/phones/<id>/adb\`. The runner
adds the emulator serial itself. Never send a single shell string: send one array item
per argument.

Only these first arguments are accepted: \`shell\`, \`exec-out\`, \`logcat\`, \`get-state\`,
\`get-serialno\`, \`get-devpath\`, \`uninstall\`. Everything else is rejected, including
\`push\`, \`pull\`, \`install\`, \`sideload\`, \`backup\`, \`restore\`, \`bugreport\`, \`emu\`,
\`sync\`, \`keygen\`, \`ppp\`, \`wait-for-*\`, global options such as \`-s\`, \`-H\`, \`-P\`, \`-L\`,
and any option in the first position. adb runs on the runner host, so a file path in an
adb command would touch the runner's filesystem, not the user's laptop.

PowerShell wrapper (define it once, then call it with a JSON array):

~~~powershell
function EmulyAdb([string]$json) { Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$id/adb" -Headers $headers -ContentType "application/json" -Body "{\`"args\`":$json}" }
~~~

Git Bash wrapper (define it once, then call it with a JSON array):

~~~bash
emulyadb() { curl.exe -sS -X POST "$base/v1/phones/$id/adb" -H "$auth" -H "content-type: application/json" --data "{\\"args\\":$1}"; }
~~~

Examples:

~~~powershell
EmulyAdb '["shell","input","tap","540","1200"]'
EmulyAdb '["shell","input","swipe","900","1800","120","600","300"]'
EmulyAdb '["shell","input","text","hello%sworld"]'
EmulyAdb '["shell","input","keyevent","KEYCODE_HOME"]'
EmulyAdb '["shell","dumpsys","battery"]'
EmulyAdb '["logcat","-d","-t","200"]'
EmulyAdb '["shell","am","start","-n","com.example.app/.MainActivity"]'
EmulyAdb '["shell","pm","list","packages"]'
~~~

~~~bash
emulyadb '["shell","input","tap","540","1200"]'
emulyadb '["shell","input","swipe","900","1800","120","600","300"]'
emulyadb '["shell","input","text","hello%sworld"]'
emulyadb '["shell","input","keyevent","KEYCODE_HOME"]'
emulyadb '["shell","dumpsys","battery"]'
emulyadb '["logcat","-d","-t","200"]'
emulyadb '["shell","am","start","-n","com.example.app/.MainActivity"]'
emulyadb '["shell","pm","list","packages"]'
~~~

In \`input text\`, use \`%s\` for spaces. Escape shell metacharacters in the text, or avoid
them. \`shell\` commands run inside the user's emulator sandbox, so normal app and system
inspection commands work. The host-level adb server commands (\`connect\`, \`reboot\`,
\`root\`, \`forward\`, and similar) are rejected by design.

File transfer is not available on this endpoint. Use these instead:

- **Install an APK:** \`POST /v1/phones/<id>/app-installs\` (the Apps upload endpoint
  below). \`adb install\`, \`install-multiple\`, \`install-multi-package\` and \`sideload\` are
  rejected.
- **Read a file from the device:** \`["exec-out","cat","/sdcard/Download/notes.txt"]\`.
  \`adb pull\` is rejected.
- **Put text on the device:** \`["shell","echo","hello",">","/sdcard/Download/notes.txt"]\`.
  \`adb push\` is rejected; for an APK, use the Apps upload endpoint.
- **Read logs:** \`["logcat","-d","-t","200"]\`. The \`-f\`, \`--file\`, \`-r\`, \`-n\` and
  \`--rotate-*\` options are rejected because they write or rotate files on the device.

Text replies are JSON:

~~~json
{"exit_code":0,"stdout":"...","stderr":""}
~~~

A non-zero \`exit_code\` is a command result, not an HTTP failure. Read \`stderr\` before
retrying. The default timeout is 30 seconds and the maximum is 120 seconds. Add
\`"timeout_s":60\` to a body when a long command needs it. Output is capped at 5 MB;
narrow the command if it is larger. One adb call runs at a time per phone; a second one
gets **409** and should be retried after the first finishes.

The phone must be running with Android ready. Otherwise the route returns **409** with a
message telling you to start it. A missing or stopped phone returns **404** or **409**;
do not create a phone to work around it.

Save a screenshot to a file. The route detects \`exec-out screencap -p\` and returns raw
PNG bytes instead of JSON:

~~~powershell
Invoke-WebRequest -Method Post -Uri "$base/v1/phones/$id/adb" -Headers $headers -ContentType "application/json" -Body '{"args":["exec-out","screencap","-p"]}' -OutFile screen.png
~~~

~~~bash
curl.exe -sS -X POST "$base/v1/phones/$id/adb" -H "$auth" -H "content-type: application/json" --data '{"args":["exec-out","screencap","-p"]}' -o screen.png
~~~

Sending \`Accept: image/png\` also asks for raw bytes. Use it only with screenshot calls.

### Install an APK with the Apps endpoint, not adb install

The real upload endpoint is \`POST /v1/phones/<id>/app-installs\`. It has two sources.

A direct HTTPS URL is the easiest:

~~~powershell
$install = @{ source = "url"; key = [guid]::NewGuid().ToString(); url = "https://example.com/app.apk" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$id/app-installs" -Headers $headers -ContentType "application/json" -Body $install
Invoke-RestMethod -Uri "$base/v1/phones/$id/app-installs/<operation-id>" -Headers $headers
~~~

~~~bash
uuid=$(powershell.exe -NoProfile -Command "[guid]::NewGuid().ToString()" | tr -d '\\r')
curl.exe -sS -X POST "$base/v1/phones/$id/app-installs" -H "$auth" -H "content-type: application/json" \\
  --data "{\\"source\\":\\"url\\",\\"key\\":\\"$uuid\\",\\"url\\":\\"https://example.com/app.apk\\"}"
curl.exe -sS -H "$auth" "$base/v1/phones/$id/app-installs/<operation-id>"
~~~

For a local file, create an \`upload\` operation, then send 4 MiB chunks with
\`PUT /v1/phones/<id>/app-installs/<operation-id>/content\`. Each chunk needs
\`content-type: application/octet-stream\`, \`x-upload-offset\` and \`x-chunk-sha256\`
(lowercase SHA-256 of that chunk). Finish with
\`POST /v1/phones/<id>/app-installs/<operation-id>/complete\`, then poll the operation
until its \`stage\` is \`succeeded\`, \`failed\`, \`cancelled\` or \`interrupted\`.

~~~bash
file="/c/Users/me/app.apk"
key=$(powershell.exe -NoProfile -Command "[guid]::NewGuid().ToString()" | tr -d '\\r')
total=$(stat -c %s "$file")
op=$(curl.exe -sS -X POST "$base/v1/phones/$id/app-installs" -H "$auth" -H "content-type: application/json" \\
  --data "{\\"source\\":\\"upload\\",\\"key\\":\\"$key\\",\\"filename\\":\\"$(basename "$file")\\",\\"totalBytes\\":$total}")
opid=$(printf '%s' "$op" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
offset=0
while [ "$offset" -lt "$total" ]; do
  chunk=$(mktemp)
  dd if="$file" of="$chunk" bs=4194304 skip=$((offset / 4194304)) count=1 status=none
  sha=$(sha256sum "$chunk" | cut -d' ' -f1)
  curl.exe -sS -X PUT "$base/v1/phones/$id/app-installs/$opid/content" -H "$auth" \\
    -H "content-type: application/octet-stream" -H "x-upload-offset: $offset" -H "x-chunk-sha256: $sha" \\
    --data-binary "@$chunk"
  offset=$((offset + $(stat -c %s "$chunk")))
  rm -f "$chunk"
done
curl.exe -sS -X POST "$base/v1/phones/$id/app-installs/$opid/complete" -H "$auth"
curl.exe -sS -H "$auth" "$base/v1/phones/$id/app-installs/$opid"
~~~

If an APK endpoint returns \`503\` with \`runner_update_required\`, the phone runner is old:
ask the user to open the phone in the browser and retry. \`POST /v1/phones/<id>/apps/update\`
also exists for that case.

Open an installed app and read the inventory:

~~~powershell
Invoke-RestMethod -Uri "$base/v1/phones/$id/apps" -Headers $headers
Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$id/apps/open" -Headers $headers -ContentType "application/json" -Body '{"packageId":"com.example.app"}'
~~~

~~~bash
curl.exe -sS -H "$auth" "$base/v1/phones/$id/apps"
curl.exe -sS -X POST "$base/v1/phones/$id/apps/open" -H "$auth" -H "content-type: application/json" --data '{"packageId":"com.example.app"}'
~~~

### Option 1 (optional): real local adb or scrcpy

Use this only when the user asks for a native adb or scrcpy connection. The default HTTP
route above needs no local tooling. If the user has no preference, keep the browser link
and option 2.

Ask first: "Do you want the browser link, or should I set up scrcpy in a native window?"
If they say yes, and only then:

1. Check \`gh --version\` and \`gh auth status\` (cases C1-C3). If either fails, stop and
   give the browser link.
2. Find the phone's codespace with \`gh codespace list --limit 20\` (cases C4-C5).
3. Tunnel the emulator's adb port in one terminal:
   \`gh codespace ssh -c <codespace-name> -- -N -L 5555:127.0.0.1:5555\`
4. In a second terminal:
   \`adb connect 127.0.0.1:5555\` then \`scrcpy -s 127.0.0.1:5555\`

Install scrcpy only from the signed package source:
\`winget install --id Genymobile.scrcpy -e --source winget\`.

- C1. \`gh --version\` must succeed.
- C2. \`gh auth status\` must show a signed-in account.
- C3. If signed out, ask the user to run \`gh auth login\` themselves. Never ask for the token.
- C4. \`gh codespace list --limit 20\` must list the user's codespaces.
- C5. Pick the codespace that belongs to this phone, preferably the newest Emuly one.
- C6. Start the tunnel with \`gh codespace ssh\` as shown above.
- C7. On any failure, stop. Keep the browser link and never send a GitHub token to Emuly.

Do not run any \`gh\` command on the default HTTP path. Only this optional path needs the
GitHub CLI, and those commands talk to GitHub directly.

### Option 3 (future, not built)

A local relay helper may come later so a desktop tool can call \`adb connect\` without the
\`gh codespace ssh\` tunnel. It is not built. Do not invent a relay URL, do not open a port
yourself, and do not wait for it. Use option 1 if the user needs local adb today.

## D. Hours and storage

- D1. The phone runs on the user's included GitHub Codespaces hours, not Emuly credit.
- D2. Free plans usually include 120 core-hours and 15 GB-month; Pro usually includes
  180 core-hours and 20 GB-month. Check \`GET /v1/usage\` when unsure.
- D3. A 4-core phone consumes about 4 core-hours per hour. 120 core-hours is about
  30 wall-clock hours; 180 is about 45.
- D4. Stopped phones still use storage. Codespaces delete stopped phones after the
  retention period; new phones keep 30 days.
- D5. Warn the user before creating many phones, and prefer reusing one.

~~~powershell
Invoke-RestMethod -Uri "$base/v1/usage" -Headers $headers
~~~

~~~bash
curl.exe -sS -H "$auth" "$base/v1/usage"
~~~

## E. Work efficiently

- E1. Read \`GET /v1/usage\` before creating a phone when the user is near a limit.
- E2. Reuse a running or stopped phone before creating a new one. \`GET /v1/phones\` shows both.
- E3. Create only when \`GET /v1/phones\` returns no phone.
- E4. Use \`idle_timeout_min: 30\` for a quick task and \`240\` for a long one.
- E5. Say what you are doing before each long step, then continue.
- E6. Send a progress line after listing, after start or creation, after boot, and after
  each app install. While Android boots, send one every 30-60 seconds.
- E7. Thinking silently counts as idle. Keep working, or the phone may stop.
- E8. At the end, ask whether to stop the phone, use \`POST /v1/phones/<id>/stop\`, and give
  the browser link one last time.

## F. API calls that work in PowerShell and Git Bash

Use \`Invoke-RestMethod\` in PowerShell and \`curl.exe\` in Git Bash. Avoid aliases that
change behavior. Always include the \`Authorization\` header. Never put the key in a URL.

List phones, read one, start, stop:

~~~powershell
Invoke-RestMethod -Uri "$base/v1/phones" -Headers $headers
Invoke-RestMethod -Uri "$base/v1/phones/$id" -Headers $headers
Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$id/start" -Headers $headers
Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$id/stop" -Headers $headers
~~~

~~~bash
curl.exe -sS -H "$auth" "$base/v1/phones"
curl.exe -sS -H "$auth" "$base/v1/phones/$id"
curl.exe -sS -X POST "$base/v1/phones/$id/start" -H "$auth"
curl.exe -sS -X POST "$base/v1/phones/$id/stop" -H "$auth"
~~~

Run one adb call:

~~~powershell
$adbCall = @{ args = @("shell", "input", "tap", "540", "1200"); timeout_s = 30 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$id/adb" -Headers $headers -ContentType "application/json" -Body $adbCall
~~~

~~~bash
curl.exe -sS -X POST "$base/v1/phones/$id/adb" -H "$auth" -H "content-type: application/json" \\
  --data '{"args":["shell","input","tap","540","1200"],"timeout_s":30}'
~~~

Create a phone:

~~~powershell
Invoke-RestMethod -Method Post -Uri "$base/v1/phones" -Headers $headers -ContentType "application/json" -Body '{"idle_timeout_min":30}'
~~~

~~~bash
curl.exe -sS -X POST "$base/v1/phones" -H "$auth" -H "content-type: application/json" --data '{"idle_timeout_min":30}'
~~~

Deleting is reserved for the browser console: \`DELETE /v1/phones/<id>\` returns **403**
for an agent key. Never try to delete around that rule.

If a request fails with a network error, report the exact URL and the error text to the
user. Do not retry more than twice without saying so.

Webhooks are optional. If the user wants push notifications instead of polling, register
one endpoint. An agent key may create and list webhooks but cannot edit, test or delete them.

~~~powershell
$hook = @{ url = "https://example.com/emuly"; events = "*" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/v1/webhooks" -Headers $headers -ContentType "application/json" -Body $hook
Invoke-RestMethod -Uri "$base/v1/webhooks" -Headers $headers
~~~

~~~bash
curl.exe -sS -X POST "$base/v1/webhooks" -H "$auth" -H "content-type: application/json" --data '{"url":"https://example.com/emuly","events":"*"}'
curl.exe -sS -H "$auth" "$base/v1/webhooks"
~~~

## Supply chain

- No \`npm install\` for Emuly.
- No \`irm ... | iex\` or \`curl ... | sh\` for Emuly.
- \`winget\` only, for scrcpy and the GitHub CLI.
- Use the browser link when an optional tool is missing.
- The agent key goes to the Emuly base URL and nowhere else.
`;
