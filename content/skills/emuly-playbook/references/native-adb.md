# Native adb or scrcpy

Use this when the user asks for native adb or scrcpy, or says yes to the scrcpy offer in
`references/phones.md`. Always keep the browser link too. Without a yes, do not run any
step below.

You do all the steps. Do not give the user a list of commands to run, and do not ask them
to open terminals. Ask the user to act only for a sign-in that needs their browser.

## 1. Check the tools

- `gh --version`, `adb --version` and `scrcpy --version` must succeed.
- If one is missing, never install it on your own. Ask first, and name each tool:
  "scrcpy needs <missing tools>, which are not installed. Install them with <package
  manager>?" Install only after the user says yes. On a no, keep the browser link and stop.
  Install commands are in the OS file, for example `references/os/windows.md`. The scrcpy
  package includes adb.
- `gh auth status` must show at least one signed-in account. If none is signed in, ask the
  user to run `gh auth login` themselves. Never ask for a GitHub token.

## 2. Find the phone's codespace

The codespace display name is the phone id, for example `phone-crystal-puffin`.

1. Run `gh codespace list --limit 50` with the active account. Find the row whose display
   name is the phone id.
2. If it is not there and `gh auth status` lists more accounts, check each one for this
   command only. Do not run `gh auth switch`, because it changes the user's setup:

   ```sh
   GH_TOKEN="$(gh auth token -u <account>)" gh codespace list --limit 50
   ```

   Use the same `GH_TOKEN` prefix for the tunnel in step 3. Never print the token.
3. If no account has it, tell the user in one line and keep the browser link.

## 3. Open the tunnel in the background

Pick a free local port, for example 5555, or 5556 if 5555 is in use. Start the tunnel as a
background task, so that it runs without a terminal window:

```sh
gh codespace ssh -c <codespace-name> -- -N -L <port>:127.0.0.1:5555
```

Wait a few seconds, then check that the local port answers.

## 4. Connect and open the window

```sh
adb connect 127.0.0.1:<port>
scrcpy -s 127.0.0.1:<port>
```

Start scrcpy in the background too, so that the window stays open while you keep working.
Then tell the user in one line: "The phone is open in a scrcpy window."

## 5. Close it

When the user closes the window or asks you to stop, run `adb disconnect 127.0.0.1:<port>`
and stop the background tunnel. Stopping the phone also ends the tunnel.

## Errors

On any failure, stop and tell the user in one line, without a stack trace. Keep the browser
link. Common causes:

- The tunnel fails: the codespace may have no SSH server, or it may be stopped.
- `adb connect` fails: the tunnel is not ready yet. Wait 5 seconds and try once more.
- The port is in use: pick another local port.

Never send a GitHub token to Emuly. Do not run any `gh` command on the default HTTP path.

A local relay helper may come later. It is not built. Do not invent a relay URL, do not open
a port yourself, and do not wait for it.
