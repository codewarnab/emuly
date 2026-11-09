# Windows key setup

These are the Windows commands for the key setup. Use PowerShell
with `Invoke-RestMethod`, or Git Bash with `curl.exe` (not the `curl` alias). Avoid
aliases that change behavior.

The only optional install on Windows is from the signed `winget` source:

- scrcpy: `winget install --id Genymobile.scrcpy -e --source winget`
- GitHub CLI (option 1 only): `winget install --id GitHub.cli -e --source winget`

The key lives in the Windows user environment variable `EMULY_KEY`. `setx` writes it, and
the read below works at once, without a restart of your agent.

Replace `<agent name>` with your agent name, for example `Claude Code`, and `your-emuly-host` with the
base URL from the prompt.

## A1. Exchange a setup code

PowerShell:

~~~powershell
$base = "https://your-emuly-host"   # the base URL from the prompt
$key = [Environment]::GetEnvironmentVariable('EMULY_KEY','User')
if (-not $key) {
  $code = "emuly_sc_..."            # the setup code from the prompt
  $body = @{ code = $code; name = "<agent name> on $env:COMPUTERNAME" } | ConvertTo-Json
  $result = Invoke-RestMethod -Method Post -Uri "$base/v1/agent/token" -ContentType "application/json" -Body $body
  cmd /c $result.save | Out-Null    # setx EMULY_KEY "..."
  $key = $result.key
}
$headers = @{ Authorization = "Bearer $key" }
~~~

Git Bash (also use `curl.exe`, not the `curl` alias):

~~~bash
base="https://your-emuly-host"
key=$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('EMULY_KEY','User')" | tr -d '\r')
if [ -z "$key" ]; then
  code="emuly_sc_..."
  response=$(curl.exe -sS -X POST "$base/v1/agent/token" -H "content-type: application/json" \
    --data "{\"code\":\"$code\",\"name\":\"<agent name> on $HOSTNAME\"}")
  key=$(printf '%s' "$response" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
  setx EMULY_KEY "$key" > /dev/null
  unset response
fi
auth="Authorization: Bearer $key"
~~~

## A2. Device sign-in flow

PowerShell:

~~~powershell
$base = "https://your-emuly-host"
$key = [Environment]::GetEnvironmentVariable('EMULY_KEY','User')
if (-not $key) {
  $start = Invoke-RestMethod -Method Post -Uri "$base/v1/agent/device"
  Write-Output "Approve this sign-in: $($start.verification_uri_complete)"
  $deadline = (Get-Date).AddSeconds($start.expires_in)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $start.interval
    try {
      $body = @{ device_code = $start.device_code } | ConvertTo-Json
      $result = Invoke-RestMethod -Method Post -Uri "$base/v1/agent/device/token" -ContentType "application/json" -Body $body
      cmd /c $result.save | Out-Null
      $key = $result.key
      break
    } catch {
      $status = $_.ErrorDetails.Message | ConvertFrom-Json
      if ($status.error -eq "authorization_pending") { continue }
      if ($status.error -eq "slow_down") { Start-Sleep -Seconds 5; continue }
      if ($status.error -eq "access_denied") { Write-Output "Sign-in was denied. Stop here."; break }
      if ($status.error -eq "expired_token") { Write-Output "The link expired. Ask the user to click Copy prompt again."; break }
      throw
    }
  }
}
$headers = @{ Authorization = "Bearer $key" }
~~~

Git Bash (also use `curl.exe`, not the `curl` alias):

~~~bash
base="https://your-emuly-host"
key=$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('EMULY_KEY','User')" | tr -d '\r')
if [ -z "$key" ]; then
  start=$(curl.exe -sS -X POST "$base/v1/agent/device")
  device=$(printf '%s' "$start" | sed -n 's/.*"device_code":"\([^"]*\)".*/\1/p')
  link=$(printf '%s' "$start" | sed -n 's/.*"verification_uri_complete":"\([^"]*\)".*/\1/p')
  interval=$(printf '%s' "$start" | sed -n 's/.*"interval":\([0-9]*\).*/\1/p')
  expires=$(printf '%s' "$start" | sed -n 's/.*"expires_in":\([0-9]*\).*/\1/p')
  printf 'Approve this sign-in: %s\n' "$link"
  waited=0
  while [ "$waited" -lt "$expires" ]; do
    sleep "$interval"
    waited=$((waited + interval))
    response=$(curl.exe -sS -X POST "$base/v1/agent/device/token" -H "content-type: application/json" \
      --data "{\"device_code\":\"$device\"}")
    error=$(printf '%s' "$response" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')
    if [ -z "$error" ]; then
      key=$(printf '%s' "$response" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
      setx EMULY_KEY "$key" > /dev/null
      unset response
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

Clear a saved key after a **401**: `setx EMULY_KEY ""`.
