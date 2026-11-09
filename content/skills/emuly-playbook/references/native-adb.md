# Native adb or scrcpy (only when the user asks)

Use this only when the user asks for a native adb or scrcpy connection. If the user has no
preference, keep the browser link and option 2.

Ask first: "Do you want the browser link, or should I set up scrcpy in a native window?"
If they say yes, and only then:

1. `gh --version` must succeed, and `gh auth status` must show a signed-in account.
   If signed out, ask the user to run `gh auth login` themselves. Never ask for the token.
2. Find the phone's codespace with `gh codespace list --limit 20`. Pick the one that
   belongs to this phone, preferably the newest Emuly one.
3. Tunnel the emulator's adb port in one terminal:
   `gh codespace ssh -c <codespace-name> -- -N -L 5555:127.0.0.1:5555`
4. In a second terminal: `adb connect 127.0.0.1:5555` then `scrcpy -s 127.0.0.1:5555`.
5. On any failure, stop. Keep the browser link and never send a GitHub token to Emuly.

Do not run any `gh` command on the default HTTP path.

## Option 3 (future, not built)

A local relay helper may come later. It is not built. Do not invent a relay URL, do not open
a port yourself, and do not wait for it. Use option 1 if the user needs local adb today.
