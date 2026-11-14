# Emuly: open one phone in a scrcpy window on this computer.
# Served by {{EMULY_BASE_URL}}/open/{{PHONE_ID}}.ps1. It holds no key and no token.
# Run:  powershell -ExecutionPolicy Bypass -c "irm {{EMULY_BASE_URL}}/open/{{PHONE_ID}}.ps1 | iex"
# Options (environment variables): EMULY_YES=1 (accept installs), EMULY_PORT=5560,
#   EMULY_ACCOUNT=<github login>, EMULY_NO_INSTALL=1, EMULY_UNINSTALL=1.
# This file is ASCII only, so every Windows PowerShell reads it the same way.
# It never calls "exit": with "irm | iex" that would close the user's window.

& {
# Continue, not Stop: in Windows PowerShell 5.1, Stop turns any stderr line of gh or adb into a crash.
$ErrorActionPreference = 'Continue'
$Phone = '{{PHONE_ID}}'
$Base = '{{EMULY_BASE_URL}}'
$PageUrl = "$Base/app/phones/$Phone"
$ScrcpyVersion = '5.0.1'
$GhVersion = '2.104.0'
$Sums = @{
  'scrcpy-win64-v5.0.1.zip' = 'b12a2c4ee8be317422451fc7dcf8ee20a71b5ea7ef9ad73ddd825a25316227a5'
  'scrcpy-winarm64-v5.0.1.zip' = '16c3fc2068df64946f670e3504b4752073ebae47a416a45b46e79a5ab19c689b'
  'gh_2.104.0_windows_amd64.zip' = '08c06d10482f12c478018cd259f64acbd5f625712cadf331aad19ba973c879e5'
  'gh_2.104.0_windows_arm64.zip' = 'd56fbf5b9ad32e5985e3e7e1d8f4d28ae2994618986cd2cba9b50ac710dffe01'
}
$Yes = $env:EMULY_YES -eq '1'
$NoInstall = $env:EMULY_NO_INSTALL -eq '1'
$Tools = Join-Path $env:LOCALAPPDATA 'Emuly\tools'

# ---------- Output ----------
# Windows Terminal draws Unicode marks. The old console often cannot, so it gets ASCII marks.
$fancy = [bool]$env:WT_SESSION -or $env:TERM_PROGRAM -eq 'vscode'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
if ($fancy) {
  $G = @{ bar = [string][char]0x2502; step = [string][char]0x25C7; ask = [string][char]0x25C6; ok = [string][char]0x2714
          warn = [string][char]0x25B2; err = [string][char]0x2716; on = [string][char]0x25CF; off = [string][char]0x25CB
          end = [string][char]0x2514; full = [string][char]0x2588; empty = [string][char]0x2591
          spin = @(0x280B,0x2819,0x2839,0x2838,0x283C,0x2834,0x2826,0x2827,0x2807,0x280F | ForEach-Object { [string][char]$_ }) }
} else {
  $G = @{ bar = '|'; step = 'o'; ask = '?'; ok = '+'; warn = '!'; err = 'x'; on = '>'; off = ' '; end = '\'
          full = '#'; empty = '-'; spin = @('|', '/', '-', '\') }
}
$interactive = -not [Console]::IsInputRedirected -and [Environment]::UserInteractive
function Line([string]$text = '', [string]$color = 'Gray') { Write-Host "$($G.bar)  $text" -ForegroundColor $color }
function Step([string]$text) { Write-Host "$($G.step)  $text" -ForegroundColor White }
function Ok([string]$text) { Write-Host "$($G.bar)  " -NoNewline -ForegroundColor DarkGray; Write-Host "$($G.ok) " -NoNewline -ForegroundColor Green; Write-Host $text }
function Warn([string]$text) { Write-Host "$($G.bar)  " -NoNewline -ForegroundColor DarkGray; Write-Host "$($G.warn) $text" -ForegroundColor Yellow }
function Fail([string]$text) { Write-Host "$($G.bar)  " -NoNewline -ForegroundColor DarkGray; Write-Host "$($G.err) $text" -ForegroundColor Red }
function Done([string]$text) { Write-Host "$($G.end)  $text" -ForegroundColor Cyan }
function Halt([string]$text) { throw "EMULY_STOP:$text" }

# Arrow keys or j/k move, Enter picks, y/n answer, Esc stops. With no keyboard, the default wins.
function Choose([string]$question, [string[]]$options, [int]$default = 0) {
  Write-Host "$($G.ask)  $question" -ForegroundColor Cyan
  if (-not $interactive) { Line "$($G.on) $($options[$default])  (no keyboard: default)" ; return $default }
  $index = $default
  $top = [Console]::CursorTop
  $draw = {
    [Console]::SetCursorPosition(0, $top)
    for ($i = 0; $i -lt $options.Count; $i++) {
      $mark = if ($i -eq $index) { $G.on } else { $G.off }
      $color = if ($i -eq $index) { 'Cyan' } else { 'DarkGray' }
      Write-Host "$($G.bar)  " -NoNewline -ForegroundColor DarkGray
      Write-Host ("$mark $($options[$i])".PadRight([Math]::Max(10, [Console]::WindowWidth - 5))) -ForegroundColor $color
    }
  }
  try { [Console]::CursorVisible = $false } catch {}
  for ($i = 0; $i -lt $options.Count; $i++) { Write-Host '' }
  $top = [Math]::Max(0, [Console]::CursorTop - $options.Count)
  & $draw
  try {
    while ($true) {
      $key = [Console]::ReadKey($true)
      switch ($key.Key) {
        'UpArrow' { $index = ($index - 1 + $options.Count) % $options.Count }
        'K' { $index = ($index - 1 + $options.Count) % $options.Count }
        'DownArrow' { $index = ($index + 1) % $options.Count }
        'J' { $index = ($index + 1) % $options.Count }
        'Tab' { $index = ($index + 1) % $options.Count }
        'Enter' { return $index }
        'Escape' { Halt 'Stopped.' }
        'Y' { if ($options.Count -eq 2) { $index = 0; & $draw; return 0 } }
        'N' { if ($options.Count -eq 2) { $index = 1; & $draw; return 1 } }
      }
      & $draw
    }
  } finally { try { [Console]::CursorVisible = $true } catch {} }
}
function Confirm([string]$question) { if ($Yes) { Write-Host "$($G.ask)  $question" -ForegroundColor Cyan; Line "$($G.on) Yes  (EMULY_YES=1)"; return $true }; (Choose $question @('Yes', 'No')) -eq 0 }

# Runs $test every 500 ms with a spinner until it returns $true, or until $seconds pass.
function Wait-Until([string]$text, [int]$seconds, [scriptblock]$test, [string]$slowHint = '', [int]$slowAfter = 0) {
  $start = Get-Date; $i = 0
  try { [Console]::CursorVisible = $false } catch {}
  try {
    while ($true) {
      if (& $test) { Write-Host "`r$($G.bar)  " -NoNewline -ForegroundColor DarkGray; Write-Host "$($G.ok) $text".PadRight(70) -ForegroundColor Green; return $true }
      $elapsed = ((Get-Date) - $start).TotalSeconds
      if ($elapsed -ge $seconds) { Write-Host "`r$($G.bar)  $($G.err) $text".PadRight(72) -ForegroundColor Red; return $false }
      $hint = if ($slowHint -and $elapsed -ge $slowAfter) { "  $slowHint" } else { '' }
      Write-Host "`r$($G.bar)  $($G.spin[$i % $G.spin.Count]) $text$hint ($([int]$elapsed) s)".PadRight(72) -NoNewline -ForegroundColor Yellow
      $i++; Start-Sleep -Milliseconds 500
    }
  } finally { try { [Console]::CursorVisible = $true } catch {} }
}

# ---------- Downloads ----------
function Get-File([string]$url, [string]$out, [string]$label) {
  $request = [Net.HttpWebRequest]::Create($url)
  $request.UserAgent = 'emuly-open'
  $response = $request.GetResponse()
  $total = $response.ContentLength
  $in = $response.GetResponseStream()
  $file = [IO.File]::Create($out)
  try {
    $buffer = New-Object byte[] 65536; $done = 0; $last = -1
    while (($read = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $file.Write($buffer, 0, $read); $done += $read
      if ($total -gt 0) {
        $pct = [int](100 * $done / $total)
        if ($pct -ne $last) {
          $filled = [int]($pct / 5)
          Write-Host "`r$($G.bar)  $label  $($G.full * $filled)$($G.empty * (20 - $filled))  $pct%  " -NoNewline -ForegroundColor Yellow
          $last = $pct
        }
      }
    }
  } finally { $file.Close(); $in.Close(); $response.Close() }
  Write-Host "`r".PadRight(78) -NoNewline; Write-Host "`r" -NoNewline
}
function Install-Zip([string]$name, [string]$url, [string]$dest, [string]$label) {
  $zip = Join-Path $env:TEMP "emuly-$name"
  Get-File $url $zip $label
  $hash = (Get-FileHash $zip -Algorithm SHA256 -ErrorAction Stop).Hash.ToLower()
  if ($hash -ne $Sums[$name]) { Remove-Item $zip -Force; Halt "The download of $name failed its checksum. Nothing was installed." }
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction Stop }
  New-Item -ItemType Directory -Force $dest -ErrorAction Stop | Out-Null
  Expand-Archive $zip $dest -Force -ErrorAction Stop
  Remove-Item $zip -Force
}
# gh starts ssh.exe as a child. Killing only gh leaves the tunnel open, so kill the whole tree.
function Stop-Tree($process) { try { & taskkill.exe /T /F /PID $process.Id 2>&1 | Out-Null } catch {} }
function Find-Exe([string]$dir, [string]$name) { Get-ChildItem $dir -Recurse -Filter $name -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }

$tunnel = $null; $serial = $null; $adb = $null; $savedToken = $env:GH_TOKEN; $errLog = $null
try {
  Write-Host ''
  Write-Host "$($G.ask)  Emuly " -NoNewline -ForegroundColor Cyan; Write-Host $Phone -ForegroundColor White
  Line

  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Halt 'PowerShell runs in Constrained Language Mode here (a company policy). Use the browser page instead.' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $arm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'
  if (-not [Environment]::Is64BitOperatingSystem) { Halt 'This needs 64-bit Windows.' }

  if ($env:EMULY_UNINSTALL -eq '1') {
    Step 'Remove Emuly tools'
    if (Test-Path $Tools) { Remove-Item $Tools -Recurse -Force; Ok "Removed $Tools" } else { Ok 'Nothing to remove' }
    Done 'Done.'; return
  }

  # ---------- Tools ----------
  Step 'Tools'
  $missing = @()
  $gh = $null
  $ghCmd = Get-Command gh -ErrorAction SilentlyContinue
  if ($ghCmd) { $gh = $ghCmd.Source } else { $gh = Find-Exe (Join-Path $Tools "gh-$GhVersion") 'gh.exe' }
  if ($gh) { Ok "gh $(((& $gh --version) | Select-Object -First 1) -replace '^gh version (\S+).*$', '$1')" } else { Warn 'gh (GitHub CLI) is not installed'; $missing += 'gh' }

  # A scrcpy on PATH works if it is 3.0 or newer and has its own adb next to it. Else use the Emuly copy.
  $scrcpy = $null
  $scCmd = Get-Command scrcpy -ErrorAction SilentlyContinue
  if ($scCmd) {
    $v = ((& $scCmd.Source --version 2>$null) | Select-Object -First 1) -replace '^scrcpy (\S+).*$', '$1'
    $sideAdb = Join-Path (Split-Path $scCmd.Source) 'adb.exe'
    if ($v -match '^(\d+)\.' -and [int]$Matches[1] -ge 3 -and (Test-Path $sideAdb)) { $scrcpy = $scCmd.Source; $adb = $sideAdb }
  }
  if (-not $scrcpy) {
    $scrcpy = Find-Exe (Join-Path $Tools "scrcpy-$ScrcpyVersion") 'scrcpy.exe'
    if ($scrcpy) { $adb = Join-Path (Split-Path $scrcpy) 'adb.exe' }
  }
  if ($scrcpy) { Ok "scrcpy $(((& $scrcpy --version 2>$null) | Select-Object -First 1) -replace '^scrcpy (\S+).*$', '$1') (with adb)" } else { Warn 'scrcpy is not installed (it includes adb)'; $missing += 'scrcpy' }
  Line

  if ($missing.Count) {
    if ($NoInstall) { Halt "Missing: $($missing -join ', '). EMULY_NO_INSTALL=1 is set, so nothing was installed." }
    $what = ($missing | ForEach-Object { if ($_ -eq 'gh') { 'gh (GitHub CLI)' } else { 'scrcpy + adb' } }) -join ' and '
    if (-not (Confirm "Install $what now? It goes in your user folder. No admin needed.")) { Halt "Nothing was installed. You can still use the page: $PageUrl" }
    Line
    Step 'Install'
    if ($missing -contains 'gh') {
      $name = "gh_${GhVersion}_windows_$(if ($arm) { 'arm64' } else { 'amd64' }).zip"
      Install-Zip $name "https://github.com/cli/cli/releases/download/v$GhVersion/$name" (Join-Path $Tools "gh-$GhVersion") "gh $GhVersion    "
      $gh = Find-Exe (Join-Path $Tools "gh-$GhVersion") 'gh.exe'
      Ok "gh $GhVersion  (checksum verified)"
    }
    if ($missing -contains 'scrcpy') {
      $name = "scrcpy-$(if ($arm) { 'winarm64' } else { 'win64' })-v$ScrcpyVersion.zip"
      Install-Zip $name "https://github.com/Genymobile/scrcpy/releases/download/v$ScrcpyVersion/$name" (Join-Path $Tools "scrcpy-$ScrcpyVersion") "scrcpy $ScrcpyVersion"
      $scrcpy = Find-Exe (Join-Path $Tools "scrcpy-$ScrcpyVersion") 'scrcpy.exe'
      $adb = Join-Path (Split-Path $scrcpy) 'adb.exe'
      Ok "scrcpy $ScrcpyVersion with adb  (checksum verified)"
    }
    Line
  }

  # ---------- GitHub accounts ----------
  Step 'Find the phone'
  $env:GH_TOKEN = $null
  function Get-Accounts { ((& $gh auth status --hostname github.com 2>&1) | Out-String) -split "`n" | ForEach-Object { if ($_ -match 'account (\S+)' -or $_ -match 'as (\S+)') { $Matches[1] } } | Select-Object -Unique }
  function Search([string]$account) {
    $token = (& $gh auth token --hostname github.com --user $account 2>$null | Out-String).Trim()
    # gh older than 2.40 has one account and no --user flag.
    if (-not $token) { $token = (& $gh auth token --hostname github.com 2>$null | Out-String).Trim() }
    if (-not $token) { return @{ account = $account; error = 'no token' } }
    $env:GH_TOKEN = $token
    try {
      $out = (& $gh codespace list --limit 100 --json name,displayName,state 2>&1 | Out-String)
      if ($LASTEXITCODE -ne 0) {
        $scope = $out -match 'codespace' -and ($out -match 'scope' -or $out -match '403' -or $out -match 'permission')
        return @{ account = $account; error = $(if ($scope) { 'scope' } else { ($out.Trim() -split "`n")[-1] }) }
      }
      # foreach, not a pipe: Windows PowerShell 5.1 sends a JSON array down a pipe as one object.
      $hit = $null
      foreach ($c in ($out | ConvertFrom-Json)) { if (-not $hit -and ($c.displayName -eq $Phone -or $c.name -like "$Phone-*")) { $hit = $c } }
      return @{ account = $account; token = $token; space = $hit }
    } finally { $env:GH_TOKEN = $null }
  }

  $space = $null; $token = $null
  while (-not $space) {
    $accounts = @(Get-Accounts)
    if ($env:EMULY_ACCOUNT) { $accounts = @($accounts | Where-Object { $_ -eq $env:EMULY_ACCOUNT }) }
    if (-not $accounts.Count) {
      Warn 'gh is not signed in to GitHub'
      if (-not (Confirm 'Sign in now? Your browser opens. Emuly never sees your GitHub token.')) { Halt 'Not signed in.' }
      & $gh auth login --hostname github.com --git-protocol https --web --scopes codespace
      Line; continue
    }
    $results = @($accounts | ForEach-Object { Search $_ })
    $found = @($results | Where-Object { $_.space })
    if ($found.Count -eq 1) { $space = $found[0].space; $token = $found[0].token; Ok "Found on account $($found[0].account)"; break }
    if ($found.Count -gt 1) {
      $pick = Choose 'The phone name is on more than one account. Which one?' @($found | ForEach-Object { $_.account })
      $space = $found[$pick].space; $token = $found[$pick].token; Ok "Using account $($found[$pick].account)"; break
    }
    $noScope = @($results | Where-Object { $_.error -eq 'scope' })
    foreach ($r in $results | Where-Object { $_.error -and $_.error -ne 'scope' }) { Warn "$($r.account): $($r.error)" }
    $options = @()
    foreach ($r in $noScope) { $options += "Give gh the codespace permission for $($r.account)" }
    $options += 'Sign in to another GitHub account'; $options += 'Stop'
    $listed = ($accounts -join ', ')
    $pick = Choose "The phone is not on $listed. What next?" $options
    if ($pick -lt $noScope.Count) {
      $who = $noScope[$pick].account
      $active = (Get-Accounts | Select-Object -First 1)
      & $gh auth switch --hostname github.com --user $who 2>$null | Out-Null
      & $gh auth refresh --hostname github.com --scopes codespace
      if ($active -and $active -ne $who) { & $gh auth switch --hostname github.com --user $active 2>$null | Out-Null }
    } elseif ($options[$pick] -like 'Sign in*') {
      & $gh auth login --hostname github.com --git-protocol https --web --scopes codespace
    } else { Halt 'Stopped.' }
    Line
  }
  $env:GH_TOKEN = $token

  if ($space.state -ne 'Available') {
    Warn "The phone is asleep ($($space.state)). Wake it on the page:"
    Line $PageUrl 'White'
    try { Start-Process $PageUrl } catch {}
    $awake = Wait-Until 'Waiting for the phone to wake' 300 {
      $state = $null
      foreach ($c in (& $gh codespace list --limit 100 --json name,state 2>$null | Out-String | ConvertFrom-Json)) { if ($c.name -eq $space.name) { $state = $c.state } }
      if ($state -ne 'Available') { Start-Sleep -Seconds 4 }
      $state -eq 'Available'
    }
    if (-not $awake) { Halt "The phone did not wake in 5 min. Wake it on the page, then run this again." }
  }
  Line

  # ---------- Tunnel ----------
  Step 'Connect'
  function Test-Port([int]$p) { try { $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $p); $l.Start(); $l.Stop(); $true } catch { $false } }
  function Test-Open([int]$p) { try { $c = [Net.Sockets.TcpClient]::new(); $c.Connect('127.0.0.1', $p); $c.Close(); $true } catch { $false } }
  $port = if ($env:EMULY_PORT) { [int]$env:EMULY_PORT } else { 5555 }
  while (-not (Test-Port $port)) { $port++ }
  $serial = "127.0.0.1:$port"
  $errLog = Join-Path $env:TEMP "emuly-tunnel-$port.log"
  $ready = $false
  for ($attempt = 1; $attempt -le 3 -and -not $ready; $attempt++) {
    $tunnel = Start-Process $gh -PassThru -NoNewWindow -RedirectStandardError $errLog -RedirectStandardOutput "$errLog.out" -ArgumentList @(
      'codespace', 'ssh', '-c', $space.name, '--', '-N', '-o', 'LogLevel=ERROR', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15', '-L', "${port}:127.0.0.1:5555")
    $ready = Wait-Until "Secure tunnel on port $port" 90 { if ($tunnel.HasExited) { return $true }; Test-Open $port } 'first time: gh sets up an SSH key' 8
    if ($tunnel.HasExited) {
      $ready = $false
      $why = (Get-Content $errLog -ErrorAction SilentlyContinue | Where-Object { $_ -and $_ -notmatch 'store now|decrypt later|openssh.com/pq' } | Select-Object -Last 1)
      Fail "The tunnel closed: $why"
      if ($attempt -lt 3) { Line "Trying again ($($attempt + 1) of 3)" 'DarkGray' }
    }
  }
  if (-not $ready) { Halt "The tunnel did not open. You can still use the page: $PageUrl" }

  # ---------- adb ----------
  $env:ADB = $adb
  & $adb connect $serial 2>&1 | Out-Null
  $booted = Wait-Until 'Android is ready' 180 {
    $state = (& $adb -s $serial get-state 2>$null | Out-String).Trim()
    if ($state -ne 'device') { & $adb connect $serial 2>&1 | Out-Null; return $false }
    (& $adb -s $serial shell getprop sys.boot_completed 2>$null | Out-String).Trim() -eq '1'
  } 'Android is still starting' 5
  if (-not $booted) { Halt "Android did not answer. Check the phone on the page: $PageUrl" }
  Line

  # ---------- scrcpy ----------
  Step 'Open the window'
  $scLog = Join-Path $env:TEMP "emuly-scrcpy-$port.log"
  $title = "Emuly - $Phone"
  # Place the window like a phone held at the right edge: 85% of the screen height, in the top-right corner.
  $placement = @()
  try {
    # scrcpy places windows in real pixels. Mark this process DPI aware, so the screen size is in real pixels too.
    if (-not ('EmulyDpi' -as [type])) { Add-Type 'using System.Runtime.InteropServices; public static class EmulyDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }' }
    [EmulyDpi]::SetProcessDPIAware() | Out-Null
    Add-Type -AssemblyName System.Windows.Forms
    $area = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $size = (& $adb -s $serial shell wm size 2>$null | Out-String)
    $w = 1080; $h = 2400
    if ($size -match 'Override size: (\d+)x(\d+)') { $w = [int]$Matches[1]; $h = [int]$Matches[2] }
    elseif ($size -match '(\d+)x(\d+)') { $w = [int]$Matches[1]; $h = [int]$Matches[2] }
    $height = [int]($area.Height * 0.85)
    $width = [int]($height * $w / $h)
    $placement = @('--window-x', ($area.Right - $width - 24), '--window-y', ($area.Top + [int]($area.Height * 0.05)), '--window-width', $width, '--window-height', $height)
  } catch {}
  $window = Start-Process $scrcpy -PassThru -NoNewWindow -RedirectStandardError $scLog -RedirectStandardOutput "$scLog.out" -ArgumentList (@(
    '-s', $serial, '--window-title', "`"$title`"", '--stay-awake') + $placement)
  Start-Sleep -Seconds 2
  if ($window.HasExited) {
    $why = Get-Content $scLog, "$scLog.out" -ErrorAction SilentlyContinue | Where-Object { $_ -match 'ERROR' } | Select-Object -Last 1
    Halt "scrcpy closed at once. $why"
  }
  Ok "The phone is open in the '$title' window"
  Line
  Done 'Close the window or press Ctrl+C here to end. Keyboard and clipboard work in the window.'
  # A tunnel alone may not count as use for GitHub. Run a short command each minute while the window is open.
  # Emuly still stops the phone when Android sees no touch or key for its idle time.
  $nextPing = (Get-Date).AddSeconds(60)
  while (-not $window.HasExited) {
    if ($tunnel.HasExited) { Fail 'The tunnel closed. The phone may have gone to sleep.'; break }
    if ((Get-Date) -ge $nextPing) {
      $nextPing = (Get-Date).AddSeconds(60)
      try { Start-Process $gh -WindowStyle Hidden -ArgumentList @('codespace', 'ssh', '-c', $space, '--', 'echo', 'emuly-awake') | Out-Null } catch {}
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $window.HasExited) { Stop-Tree $window }
  Write-Host ''
  Write-Host 'Closed.' -ForegroundColor DarkGray
} catch {
  $message = $_.Exception.Message
  if ($message -like 'EMULY_STOP:*') { Fail $message.Substring(11); Write-Host ''; return }
  Fail "Unexpected error: $message"
  Line "The page still works: $PageUrl" 'DarkGray'
  Write-Host ''
} finally {
  if ($serial -and $adb) { & $adb disconnect $serial 2>&1 | Out-Null }
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Tree $tunnel }
  if ($errLog) { Remove-Item $errLog, "$errLog.out" -ErrorAction SilentlyContinue }
  $env:GH_TOKEN = $savedToken
  try { [Console]::CursorVisible = $true } catch {}
}
}
