# Show an Emuly phone in T3 Code (Windows)

Read this when the user wants to see an Emuly phone in T3 Code (Settings → Devices) and
T3 Code runs on Windows. For Linux, read `references/t3code.md`. The idea is the same: 3
helper files make T3 Code find an Android SDK.

On Windows, the files must be:

- `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`
- `%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe`
- `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest\bin\avdmanager.bat`

T3 Code's device hub starts `adb.exe` and `emulator.exe` with Node `execFile` and `spawn`,
with no shell. So these 2 must be real programs. A `.cmd` or `.bat` file does not work for
them. You compile 2 small C# programs with `csc.exe`, which comes with Windows (.NET
Framework 4). `avdmanager.bat` runs through `cmd.exe`, so a batch file works for it.

Run the commands below in PowerShell. Tested on Windows 11 with adb 37.0.0.

## 1. Check that this is the right machine

T3 Code reads files on the computer where T3 Code runs. If T3 Code runs on another
computer, stop. Tell the user in one line that the helper files must go on that computer.

## 2. Check for a real SDK

```powershell
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
Test-Path "$sdk\platform-tools\adb.exe", "$sdk\emulator\emulator.exe", "$sdk\cmdline-tools\latest\bin\avdmanager.bat"
Select-String -Path "$sdk\platform-tools\adb.exe" -Pattern emuly-t3code -SimpleMatch -List
```

- If all 3 are `True` and `Select-String` prints nothing, the user has a real SDK. Do not
  add the helper files. T3 Code already works; go to step 5.
- If `Select-String` prints a match, the helper files are already in place. Go to step 5.
- If `ANDROID_HOME` points to a real SDK with missing parts, stop and tell the user. Never
  change their SDK.

## 3. Find the real adb

The helper `adb.exe` passes every command to a real adb.

```powershell
Get-Command adb -All -ErrorAction SilentlyContinue | ? Source -notlike "*\Android\Sdk\*" | % Source
Test-Path "$env:LOCALAPPDATA\Android\platform-tools\adb.exe"
```

Pick one real adb and keep its full path as `$realAdb`. If none exists, ask: "T3 Code needs
adb, which is not installed. Install it with `winget install Google.PlatformTools`?"
Install only after a yes, then run the check again.

scrcpy also ships an adb. Two adb versions on one computer stop each other's server. After
the setup, use the helper `adb.exe` for every adb command.

## 4. Ask, then add the helper files

Ask once:

```text
T3 Code shows Android only when it finds the Android tools. I can add 3 small helper files
in %LOCALAPPDATA%\Android\Sdk so that T3 Code shows your Emuly phone. I can remove them
any time. Add them?
```

On a no, keep the browser link and stop. On a yes, run this with the `$realAdb` from step 3:

```powershell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
New-Item -ItemType Directory -Force "$sdk\platform-tools", "$sdk\emulator", "$sdk\cmdline-tools\latest\bin" | Out-Null

@'
// emuly-t3code: adb helper for T3 Code. Safe to delete.
// "emu avd name" -> print emuly-phone / OK. Anything else -> real adb.
using System; using System.Diagnostics; using System.IO; using System.Reflection; using System.Text; using System.Threading;
[assembly: AssemblyDescription("emuly-t3code")]
class P {
  const string Marker = "emuly-t3code";
  const string RealAdb = @"__REAL_ADB__";
  static string Q(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[]{' ','\t','"'}) < 0) return a;
    var sb = new StringBuilder("\""); int bs = 0;
    foreach (char c in a) {
      if (c == (char)92) { bs++; continue; }
      if (c == '"') { sb.Append((char)92, bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
      sb.Append((char)92, bs); bs = 0; sb.Append(c);
    }
    sb.Append((char)92, bs * 2); sb.Append('"'); return sb.ToString();
  }
  static Thread Pump(Stream from, Stream to) {
    var t = new Thread(() => { try { from.CopyTo(to); to.Flush(); } catch { } });
    t.IsBackground = true; t.Start(); return t;
  }
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, int mask, int flags);
  static int Main(string[] args) {
    foreach (int n in new[]{-10, -11, -12}) SetHandleInformation(GetStdHandle(n), 1, 0);
    if (string.Join(" ", args).Contains("emu avd name")) { Console.Write("emuly-phone\r\nOK\r\n"); return 0; }
    // Start the server with ShellExecute so it inherits no handle of the caller.
    // If adb starts the server itself, the server keeps the caller's stdout open and execFile never returns.
    if (Array.IndexOf(args, "kill-server") < 0) {
      try {
        var s = new ProcessStartInfo(Environment.ExpandEnvironmentVariables(RealAdb), "start-server");
        s.UseShellExecute = true; s.WindowStyle = ProcessWindowStyle.Hidden;
        using (var sp = Process.Start(s)) { sp.WaitForExit(15000); }
      } catch { }
    }
    var sb = new StringBuilder(); foreach (var a in args) { if (sb.Length > 0) sb.Append(' '); sb.Append(Q(a)); }
    var psi = new ProcessStartInfo(Environment.ExpandEnvironmentVariables(RealAdb), sb.ToString());
    psi.UseShellExecute = false; psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
    psi.RedirectStandardInput = true;
    using (var p = Process.Start(psi)) {
      p.StandardInput.Close();
      var o = Pump(p.StandardOutput.BaseStream, Console.OpenStandardOutput());
      var e = Pump(p.StandardError.BaseStream, Console.OpenStandardError());
      p.WaitForExit();
      o.Join(2000); e.Join(2000);
      return p.ExitCode;
    }
  }
}
'@.Replace("__REAL_ADB__", $realAdb) | Set-Content -Encoding utf8 "$sdk\platform-tools\emuly-adb.cs"

@'
// emuly-t3code: emulator helper for T3 Code. Prints nothing, exits 0. Safe to delete.
using System.Reflection;
[assembly: AssemblyDescription("emuly-t3code")]
class P { const string Marker = "emuly-t3code"; static int Main(string[] a) { return 0; } }
'@ | Set-Content -Encoding utf8 "$sdk\emulator\emuly-emulator.cs"

"@echo off`r`nrem emuly-t3code: avdmanager helper for T3 Code. Prints nothing, exits 0. Safe to delete.`r`nexit /b 0" |
  Set-Content -Encoding ascii "$sdk\cmdline-tools\latest\bin\avdmanager.bat"

$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc -nologo "-out:$sdk\platform-tools\adb.exe" "$sdk\platform-tools\emuly-adb.cs"
& $csc -nologo "-out:$sdk\emulator\emulator.exe" "$sdk\emulator\emuly-emulator.cs"
```

The `.cs` files stay next to the programs, so the user can see what each one does.

Do not remove the `start-server` block. Without it, the first adb call after a restart
hangs T3 Code: the adb server that adb starts keeps the caller's output pipe open, so Node
`execFile` never returns. The real adb alone does not have this problem.

Check the helper:

```powershell
& "$sdk\platform-tools\adb.exe" -s x emu avd name   # emuly-phone, OK
& "$sdk\platform-tools\adb.exe" version             # the real adb version
```

## 5. Connect the phone

Follow `references/native-adb.md` steps 1 to 3 to open the tunnel. You need `gh` and adb
only, not scrcpy. If the codespace was stopped, the phone must boot again first, and
`adb connect` shows `offline` until it does. Then:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" connect 127.0.0.1:<port>
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" devices
```

The phone must show as `device`. Then tell the user: "Restart T3 Code. Your phone is under
Settings → Devices." Keep the browser link too.

## 6. Close it

When the user is done, run the helper `adb.exe disconnect 127.0.0.1:<port>` and stop the
tunnel, as in `references/native-adb.md` step 5. Leave the helper files in place.

## Remove the helper files

Only when the user asks. Remove only files that contain `emuly-t3code`:

```powershell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
"platform-tools\adb.exe", "platform-tools\emuly-adb.cs", "emulator\emulator.exe",
"emulator\emuly-emulator.cs", "cmdline-tools\latest\bin\avdmanager.bat" | % {
  $f = Join-Path $sdk $_
  if (Select-String -Path $f -Pattern emuly-t3code -SimpleMatch -List -ErrorAction SilentlyContinue) { Remove-Item $f }
}
```
