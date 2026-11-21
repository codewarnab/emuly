# Show an Emuly phone in T3 Code (macOS)

Read this when the user wants to see an Emuly phone in T3 Code (Settings → Devices) and
T3 Code runs on macOS (Apple Silicon or Intel). For Linux, read `references/t3code.md`. The
idea is the same: 3 helper files make T3 Code find an Android SDK.

T3 Code looks for the SDK in `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then
`~/Library/Android/sdk` (the Android Studio default on macOS). It needs
`platform-tools/adb`, `emulator/emulator` and `cmdline-tools/latest/bin/avdmanager`. An `adb`
on `PATH` alone does not turn on Android.

T3 Code starts these tools with no shell. On macOS the kernel runs a file that starts with
`#!/bin/sh` and has the execute bit, so small shell scripts work. The C# step from Windows is
not needed. Scripts you make on the Mac have no quarantine flag, so Gatekeeper does not block them.

Steps 2 and 3 of "T3 Code" in `SKILL.md` (turn on devices, show the phone) come after
this file.

## 1. Check that this is the right machine

T3 Code reads files on the computer where T3 Code runs. If you run over SSH on another
computer and T3 Code runs on the user's Mac, stop. Tell the user in one line that the
helper files must go on the Mac that runs T3 Code.

## 2. Check for a real SDK

```bash
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ls "$sdk/platform-tools/adb" "$sdk/emulator/emulator" "$sdk/cmdline-tools/latest/bin/avdmanager" 2>&1
grep -l "emuly-t3code" "$sdk/platform-tools/adb" 2>/dev/null
```

- If all 3 files exist and `grep` prints nothing, the user has a real SDK (for example from
  Android Studio). Do not add the helper files. T3 Code already works; go to step 5.
- If `grep` prints the path, the helper files are already in place. Go to step 5.
- If `ANDROID_HOME` or `ANDROID_SDK_ROOT` points to a real SDK with missing parts, stop and
  tell the user. Never change their SDK.
- If the helper files are in place, but the folder now also has real SDK parts (for example
  `platforms`, `system-images`, or an `adb` without `emuly-t3code`), the user installed a real
  SDK. Offer once to remove the helper files (see the end of this file).

## 3. Find the real adb

The helper `adb` passes every command to a real adb. Agent shells often do not load
Homebrew's `PATH`, so also check the 2 Homebrew folders by full path:

```bash
real_adb=$(PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v "Library/Android/sdk" | paste -sd: -) command -v adb)
for f in /opt/homebrew/bin/adb /usr/local/bin/adb; do [ -z "$real_adb" ] && [ -x "$f" ] && real_adb="$f"; done
echo "${real_adb:-none}"
```

If it prints `none`, ask: "T3 Code needs adb, which is not installed. Install it with
`brew install --cask android-platform-tools`?" Install only after a yes, then run the check
again. The Homebrew adb is a universal binary, so it runs natively on Apple Silicon and Intel.

Keep the full path. T3 Code opened from the Dock has a short `PATH` without Homebrew, so the
helper must call the real adb by its full path.

## 4. Ask, then add the helper files

Ask once:

```text
T3 Code shows Android only when it finds the Android tools. I can add 3 small helper files
in ~/Library/Android/sdk so that T3 Code shows your Emuly phone. I can remove them any time.
Add them?
```

On a no, keep the browser link and stop. On a yes, run this with the `real_adb` from step 3:

```bash
sdk="$HOME/Library/Android/sdk"
mkdir -p "$sdk/platform-tools" "$sdk/emulator" "$sdk/cmdline-tools/latest/bin"

cat > "$sdk/platform-tools/adb" <<EOF
#!/bin/sh
# emuly-t3code: answers "emu avd name", which fails for a phone reached over the network.
# Every other command goes to the real adb. Safe to delete.
case " \$* " in
  *" emu avd name "*) echo emuly-phone; echo OK; exit 0 ;;
  *" kill-server "*) ;;
  # Start the server with no link to the caller's output, so T3 Code never waits on it.
  *) "$real_adb" start-server </dev/null >/dev/null 2>&1 ;;
esac
exec "$real_adb" "\$@"
EOF

cat > "$sdk/emulator/emulator" <<'EOF'
#!/bin/sh
# emuly-t3code: no local emulator. "-list-avds" prints an empty list. Safe to delete.
[ "$1" = "-list-avds" ] && exit 0
echo "No local emulator. Emuly phones run in a codespace." >&2
exit 1
EOF

cat > "$sdk/cmdline-tools/latest/bin/avdmanager" <<'EOF'
#!/bin/sh
# emuly-t3code: no local virtual devices. Safe to delete.
exit 0
EOF

chmod +x "$sdk/platform-tools/adb" "$sdk/emulator/emulator" "$sdk/cmdline-tools/latest/bin/avdmanager"
```

Check the helper:

```bash
"$HOME/Library/Android/sdk/platform-tools/adb" -s x emu avd name   # emuly-phone, OK
"$HOME/Library/Android/sdk/platform-tools/adb" version             # the real adb version
```

## 5. Connect the phone

Follow `references/native-adb.md` steps 1 to 3 to open the tunnel. You need `gh` and adb
only, not scrcpy. On macOS, check the port with `nc -z 127.0.0.1 <port>`. If the codespace
was stopped, the phone must boot again first, and `adb connect` shows `offline` until it
does. Then:

```bash
"$HOME/Library/Android/sdk/platform-tools/adb" connect 127.0.0.1:<port>
"$HOME/Library/Android/sdk/platform-tools/adb" devices
```

The phone must show as `device`. Then do steps 2 and 3 of "T3 Code" in `SKILL.md`. If the
phone does not show, tell the user: "Quit T3 Code (Cmd+Q) and open it again." Keep the
browser link too.

## 6. Close it

When the user is done, run the helper `adb disconnect 127.0.0.1:<port>` and stop the
tunnel, as in `references/native-adb.md` step 5. Leave the helper files in place.

## Remove the helper files

Only when the user asks. Remove only files that contain `emuly-t3code`:

```bash
sdk="$HOME/Library/Android/sdk"
for f in platform-tools/adb emulator/emulator cmdline-tools/latest/bin/avdmanager; do
  grep -q emuly-t3code "$sdk/$f" 2>/dev/null && rm -f "$sdk/$f"
done
```
