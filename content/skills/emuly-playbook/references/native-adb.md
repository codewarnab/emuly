# Native adb or scrcpy

Use this when the user asks for native adb or scrcpy, or says yes to the scrcpy offer in
`references/phones.md`. Always keep the browser link too. Without a yes, do not run any
step below.

1. `gh --version` must succeed, and `gh auth status` must show a signed-in account.
   If signed out, ask the user to run `gh auth login` themselves. Never ask for the token.
2. `adb` and `scrcpy` must be installed. If one is missing, ask before you install it (see
   the OS file, for example `references/os/windows.md`).
3. Find the phone's codespace with `gh codespace list --limit 20`. Pick the one that
   belongs to this phone, preferably the newest Emuly one.
4. Tunnel the emulator's adb port in one terminal. Run it in the background when your
   tools allow it:
   `gh codespace ssh -c <codespace-name> -- -N -L 5555:127.0.0.1:5555`
5. In a second terminal: `adb connect 127.0.0.1:5555` then `scrcpy -s 127.0.0.1:5555`.
6. On any failure, stop and tell the user in one line. Keep the browser link, and never send
   a GitHub token to Emuly.

Do not run any `gh` command on the default HTTP path.

A local relay helper may come later. It is not built. Do not invent a relay URL, do not open
a port yourself, and do not wait for it.
