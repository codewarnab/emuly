# Read and tap the screen with agent-device

> Read this file only if the task needs to see or tap the screen. If not, stop reading now, and do not read the
> other files in this folder.

## Offer it, or install it

The first time a task needs to see or tap the app, call
`GET <base>/v1/phones/<id>/agent-device` with the same header.

- **404**: never mention agent-device again. Use `GET <base>/v1/phones/<id>/ui` (the UI tree
  as JSON with tap points, `references/tasks/adb.md`).
- **Otherwise**: run `agent-device --version`. If it prints `{{AGENT_DEVICE_VERSION}}`, use it;
  the recipes are below. If it prints another version, say in
  one line that another copy shadows it, then use adb. Do not reinstall.
- **Missing**: run `node --version`, then ask once per session, with this exact copy:

  ```text
  I can install a small helper called agent-device. Without it I guess tap positions from a picture.
  With it I read the real buttons and text, the way a person does.
  It needs Node 22.12 or newer, and one install on your computer. Install it?

  https://agent-device.dev/
  ```

  If Node is missing or older than 22.12, put this line before the question: "You have Node
  <version | not installed>. It needs 22.12 or newer, so I will install/update Node first."

- Never install without an explicit yes, and never `npx -y`. Remember a "no" yourself for
  the rest of the session, because Emuly cannot. Reply: "No problem. I will read the screen
  with Android's own UI dump instead." Then use `GET <base>/v1/phones/<id>/ui`.
- **After a yes**: Node first if it is missing or old, through the version manager the user
  already has (nvm, fnm, volta, mise, asdf), else the OS package manager (winget, brew, apt),
  else give https://nodejs.org/en/download and wait. Then run `node --version` again.
- **Package manager**: the user's words first, then a memory file (AGENTS.md, CLAUDE.md,
  .cursor/rules) that names one, then a lockfile (pnpm-lock.yaml, bun.lock or bun.lockb,
  package-lock.json). If none matches, ask: "You use pnpm, bun, or npm? I need it for one
  global install." A `yarn.lock` on its own means npm.
- Install with one of these, and never `@latest`:
  `npm install -g agent-device@{{AGENT_DEVICE_VERSION}}`,
  `pnpm add -g agent-device@{{AGENT_DEVICE_VERSION}}` (needs `pnpm setup` once), or
  `bun add -g agent-device@{{AGENT_DEVICE_VERSION}}` (Node is still required). Then check
  that `agent-device --version` prints the pin.
- **How to use it**: only when agent-device is in use (installed, or the user said yes),
  read https://agent-device.dev/docs/introduction before the first command. Do not fetch the docs when the user said no or the
  route gave 404.
- The token from the route never appears in chat or in a file in the user's repo.


## Use it

Use this when the agent-device route answers and `agent-device --version` prints the pin.
Emuly calls still need the `EMULY_KEY` header. The proxy token is a different secret.

1. **Get the proxy details.** Ask the phone for its own proxy:

   ```sh
   curl -sS -H "Authorization: Bearer $EMULY_KEY" \
     "$base/v1/phones/<id>/agent-device"
   ```

   The reply is `{ base_url, token, version, session }`. A **404** means this phone has no
   proxy: use `references/tasks/adb.md` instead and stop here. Never print `token`, never write it
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

   **Recommended: check the screen before you say "done".** Use this when a step must
   change the screen, for example a sign-in, a save or a navigation. It is not needed for
   every tap. After the step, prove the result with one of these:

   ```sh
   agent-device wait text "Welcome"
   agent-device diff snapshot
   ```

   `wait text` waits until the text appears on the screen. `diff snapshot` shows what
   changed since the last snapshot. If the screen does not show the expected result, do not
   report the step as done. Tell the user what the screen shows instead.

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
     and continue with adb from `references/tasks/adb.md`.
