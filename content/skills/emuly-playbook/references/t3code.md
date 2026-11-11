# Show an Emuly phone in T3 Code (Linux)

Read this when the user wants to see an Emuly phone in T3 Code (Settings → Devices).

T3 Code shows Android only when it finds an Android SDK: `adb`, `emulator` and
`avdmanager`. An Emuly phone runs in a codespace, so the user has no SDK. Until T3 Code
supports adb on its own, you add 3 small helper files that make T3 Code find one.

This file covers Linux only. On Windows or macOS, say in one line that this is not
supported yet, and keep the browser link.

## 1. Check that this is the right machine

T3 Code reads files on the computer where T3 Code runs. If you run on a remote machine
(see `references/remote.md`) and T3 Code runs on the user's own computer, stop. Tell the
user in one line that the helper files must go on the computer that runs T3 Code.

## 2. Check for a real SDK

```bash
sdk="${ANDROID_HOME:-$HOME/Android/Sdk}"
ls "$sdk/platform-tools/adb" "$sdk/emulator/emulator" "$sdk/cmdline-tools/latest/bin/avdmanager" 2>&1
grep -l "emuly-t3code" "$sdk/platform-tools/adb" 2>/dev/null
```

- If all 3 files exist and `grep` prints nothing, the user has a real SDK. Do not add the
  helper files. T3 Code already works; go to step 5.
- If `grep` prints the path, the helper files are already in place. Go to step 5.
- If `ANDROID_HOME` points to a real SDK with missing parts, stop and tell the user. Never
  change their SDK.

## 3. Find the real adb

The helper `adb` passes every command to a real adb.

```bash
real_adb=$(PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v "Android/Sdk" | paste -sd:) command -v adb)
echo "${real_adb:-none}"
```

If it prints `none`, ask: "T3 Code needs adb, which is not installed. Install it with
`sudo apt install adb`?" Install only after a yes, then run the check again.

## 4. Ask, then add the helper files

Ask once:

```text
T3 Code shows Android only when it finds the Android tools. I can add 3 small helper files
in ~/Android/Sdk so that T3 Code shows your Emuly phone. I can remove them any time.
Add them?
```

On a no, keep the browser link and stop. On a yes, run this with the `real_adb` from step 3:

```bash
sdk="$HOME/Android/Sdk"
mkdir -p "$sdk/platform-tools" "$sdk/emulator" "$sdk/cmdline-tools/latest/bin"

cat > "$sdk/platform-tools/adb" <<EOF
#!/bin/sh
# emuly-t3code: answers "emu avd name", which fails for a phone reached over the network.
# Every other command goes to the real adb.
case " \$* " in
  *" emu avd name "*) echo emuly-phone; echo OK; exit 0 ;;
esac
exec "$real_adb" "\$@"
EOF

cat > "$sdk/emulator/emulator" <<'EOF'
#!/bin/sh
# emuly-t3code: no local emulator. "-list-avds" prints an empty list.
[ "$1" = "-list-avds" ] && exit 0
echo "No local emulator. Emuly phones run in a codespace." >&2
exit 1
EOF

cat > "$sdk/cmdline-tools/latest/bin/avdmanager" <<'EOF'
#!/bin/sh
# emuly-t3code: no local virtual devices.
exit 0
EOF

chmod +x "$sdk/platform-tools/adb" "$sdk/emulator/emulator" "$sdk/cmdline-tools/latest/bin/avdmanager"
```

## 5. Connect the phone

Follow `references/native-adb.md` steps 1 to 3 to open the tunnel. You need `gh` and adb
only, not scrcpy. Then:

```bash
"$HOME/Android/Sdk/platform-tools/adb" connect 127.0.0.1:<port>
"$HOME/Android/Sdk/platform-tools/adb" devices
```

The phone must show as `device`. Then tell the user: "Restart T3 Code. Your phone is under
Settings → Devices." Keep the browser link too.

## 6. Close it

When the user is done, run `adb disconnect 127.0.0.1:<port>` and stop the tunnel, as in
`references/native-adb.md` step 5. Leave the helper files in place.

## Remove the helper files

Only when the user asks. Remove only files that contain `emuly-t3code`:

```bash
sdk="$HOME/Android/Sdk"
for f in platform-tools/adb emulator/emulator cmdline-tools/latest/bin/avdmanager; do
  grep -q emuly-t3code "$sdk/$f" 2>/dev/null && rm -f "$sdk/$f"
done
```
