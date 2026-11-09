/** Static, versioned runbook served at /agent.md. It documents only routes that exist under app/v1. */
export const AGENT_RUNBOOK_VERSION = "2026-11-09.1";

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

## Rules that do not change

- Never print, log, paste into chat, or send the agent key anywhere except Emuly.
- Send the key only in an \`Authorization: Bearer\` header to the Emuly base URL in the prompt.
- Do not use \`npm install\`, \`irm ... | iex\`, \`curl ... | sh\`, or any other remote script for Emuly.
  The only optional install in this runbook is scrcpy through \`winget\`.
- A 4-core phone uses 4 core-hours for every wall-clock hour. A 30-minute idle stop is
  best for short tasks. Choose 240 minutes (4 hours) only when the task really is long.
- Thinking or waiting without terminal or editor activity counts as idle to GitHub.
  Keep progress moving, or tell the user the phone may stop.
- Give the user a short progress update at each stage: key, create, boot, install, done.
- Do not create a second phone when a stopped or running phone can be reused.
- At the end, ask whether to stop the phone. The current v1 API has no stop route:
  ask the user to click **Stop** in the browser console. Stopping keeps the phone and its apps.

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

## B. Create and view the phone

The browser link is the default way to watch and touch the phone. Print every link as
plain text on its own line, never as a hidden or shortened link.

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

The v1 API has no list or read route yet. If you lose the phone id, ask the user for
the phone link from the console instead of creating another phone.

Wait for Android to be ready by polling the Apps inventory. A \`409\` means the phone
is still booting; a \`200\` means Apps are available.

~~~powershell
Invoke-RestMethod -Uri "$base/v1/phones/$($phone.id)/apps" -Headers $headers
~~~

### scrcpy is opt-in, not the default

Ask first: "Do you want the browser link, or should I set up scrcpy in a native window?"
Use scrcpy only if the user explicitly says yes. If they do not answer, keep the browser link.

If they say yes, and only then:

1. Check \`winget --version\`. If it is missing, stop and give the browser link.
2. Install scrcpy from the signed package source:
   \`winget install --id Genymobile.scrcpy -e --source winget\`
3. Check \`gh --version\` and \`gh auth status\`. If \`gh\` is missing or signed out, stop
   and give the browser link. Never ask the user to paste a GitHub token into chat.
4. Find the phone's codespace with \`gh codespace list --limit 20\`. Use the newest
   Emuly codespace for this phone; the phone page in the console shows its name.
5. Tunnel the emulator's adb port in one terminal:
   \`gh codespace ssh -c <codespace-name> -- -N -L 5555:127.0.0.1:5555\`
6. In a second terminal:
   \`adb connect 127.0.0.1:5555\` then \`scrcpy -s 127.0.0.1:5555\`

If any check fails, do not improvise an install. Give the user the browser link again.

## C. GitHub CLI checks (scrcpy path only)

Do not run any \`gh\` command on the normal browser path. Only the scrcpy path needs
GitHub CLI, and those commands talk to GitHub directly.

- C1. \`gh --version\` must succeed.
- C2. \`gh auth status\` must show a signed-in account.
- C3. If signed out, ask the user to run \`gh auth login\` themselves. Never ask for the token.
- C4. \`gh codespace list --limit 20\` must list the user's codespaces.
- C5. Pick the codespace that belongs to this phone, preferably the newest Emuly one.
- C6. Start the tunnel with \`gh codespace ssh\` as shown above.
- C7. On any failure, stop. Keep the browser link and never send a GitHub token to Emuly.

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
- E2. Reuse a stopped phone before creating a new one.
- E3. Reuse a running phone for a second task on the same day.
- E4. Use \`idle_timeout_min: 30\` for a quick task and \`240\` for a long one.
- E5. Say what you are doing before each long step, then continue.
- E6. Send a progress line after creation, after boot, and after each app install.
- E7. Thinking silently counts as idle. Keep working, or the phone may stop.
- E8. At the end, ask whether to stop the phone and give the browser link one last time.

## F. API calls that work in PowerShell and Git Bash

Use \`Invoke-RestMethod\` in PowerShell and \`curl.exe\` in Git Bash. Avoid aliases that
change behavior. Always include the \`Authorization\` header. Never put the key in a URL.

Create a phone:

~~~powershell
Invoke-RestMethod -Method Post -Uri "$base/v1/phones" -Headers $headers -ContentType "application/json" -Body '{"idle_timeout_min":30}'
~~~

~~~bash
curl.exe -sS -X POST "$base/v1/phones" -H "$auth" -H "content-type: application/json" --data '{"idle_timeout_min":30}'
~~~

Install an APK from a direct HTTPS URL. The \`key\` is any new UUID; reuse it only for retries
of the same install.

~~~powershell
$install = @{ source = "url"; key = [guid]::NewGuid().ToString(); url = "https://example.com/app.apk" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$($phone.id)/app-installs" -Headers $headers -ContentType "application/json" -Body $install
Invoke-RestMethod -Uri "$base/v1/phones/$($phone.id)/app-installs/<operation-id>" -Headers $headers
~~~

~~~bash
uuid=$(powershell.exe -NoProfile -Command "[guid]::NewGuid().ToString()" | tr -d '\\r')
curl.exe -sS -X POST "$base/v1/phones/$id/app-installs" -H "$auth" -H "content-type: application/json" \\
  --data "{\\"source\\":\\"url\\",\\"key\\":\\"$uuid\\",\\"url\\":\\"https://example.com/app.apk\\"}"
curl.exe -sS -H "$auth" "$base/v1/phones/$id/app-installs/<operation-id>"
~~~

Open an installed app and read the inventory:

~~~powershell
Invoke-RestMethod -Uri "$base/v1/phones/$($phone.id)/apps" -Headers $headers
Invoke-RestMethod -Method Post -Uri "$base/v1/phones/$($phone.id)/apps/open" -Headers $headers -ContentType "application/json" -Body '{"packageId":"com.example.app"}'
~~~

~~~bash
curl.exe -sS -H "$auth" "$base/v1/phones/$id/apps"
curl.exe -sS -X POST "$base/v1/phones/$id/apps/open" -H "$auth" -H "content-type: application/json" --data '{"packageId":"com.example.app"}'
~~~

Uploading a local APK uses the same \`app-installs\` operation in 4 MiB chunks with
\`PUT .../content\`, then \`POST .../complete\`. Prefer a direct HTTPS URL when one exists.
The current v1 API does not expose tap, type, key, screenshot, start, stop, list or
read routes. Use the browser link for those; never claim you performed an action that
the API does not expose. Deleting is reserved for the browser console: \`DELETE
/v1/phones/<id>\` returns 403 for an agent key. Never try to delete around that rule.

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
