# Read and tap the screen with agent-device

Use this when the agent-device route answers and `agent-device --version` prints the pin.
Emuly calls still need the `EMULY_KEY` header. The proxy token is a different secret.

1. **Get the proxy details.** Ask the phone for its own proxy:

   ```sh
   curl -sS -H "Authorization: Bearer $EMULY_KEY" \
     "{{EMULY_BASE_URL}}/v1/phones/<id>/agent-device"
   ```

   The reply is `{ base_url, token, version, session }`. A **404** means this phone has no
   proxy: use `references/adb.md` instead and stop here. Never print `token`, never write it
   to a file in the user's repository, and never put it in `agent-device.json`.

2. **Keep the token and session in environment variables.** Every remote command needs a
   session, or the CLI answers `REMOTE_SESSION_REQUIRED`.

   ```sh
   export AGENT_DEVICE_DAEMON_AUTH_TOKEN="<token>"
   export AGENT_DEVICE_SESSION="<session>"
   ```

   Do not pass `--daemon-auth-token`: it covers one command only, so the next call fails.

3. **Connect once per session.**

   ```sh
   agent-device connect proxy --daemon-base-url <base_url>
   ```

4. **Drive the app in a loop.** `open` must come first: snapshot, press and screenshot all
   need an open session. Take a fresh snapshot after any change to the screen, then use
   the new refs. Refs look like `@e2`.

   ```sh
   agent-device open com.example.app --platform android
   agent-device snapshot -i
   agent-device press @e2 --settle
   agent-device fill @e7 "text" --settle
   agent-device diff snapshot
   agent-device screenshot <scratchpad path>.png
   ```

   The first snapshot installs a small Android helper on the phone, so it is slow once.
   Later snapshots are quick.

5. **Screenshots and video** go to the agent scratchpad or a temporary folder, never to the
   user's repository. Read them as images to check what the screen shows.

6. **Finish cleanly** with `agent-device close`, then `agent-device disconnect`.

7. **Errors:**

   - `Invalid proxy token` (HTTP 401): the token is wrong or rotated, usually because the
     phone restarted. Call the route again once, re-export `AGENT_DEVICE_DAEMON_AUTH_TOKEN`,
     and run `agent-device connect proxy` again.
   - A message containing "policy denies", for example
     `Error (UNAUTHORIZED): This daemon's policy denies the boot command.`: `boot` and
     `shutdown` are blocked on Emuly phones, and shutdown fails the same way. Use
     `POST /v1/phones/<id>/start` or `POST /v1/phones/<id>/stop` instead. Do not retry the
     command.
   - `No active proxy device lease for this session; run open first.`: the session has no
     open app. Every device command needs one, so run
     `agent-device open <package> --platform android` first.
   - Anything else: `agent-device disconnect`, tell the user in one line (no stack trace),
     and continue with adb from `references/adb.md`.
