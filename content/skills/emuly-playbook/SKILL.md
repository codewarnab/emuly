---
name: emuly-playbook
description: Run and drive Android phones with Emuly (emulators in the user's GitHub Codespaces) over its HTTP API. Use when the user asks to start, reuse, control, screenshot, install apps on, test on, stop, or delete an Emuly phone, or an Android phone or emulator for testing.
---

# Emuly playbook

Emuly runs an Android emulator in the user's own GitHub Codespace, on the hours in their
GitHub plan. Never ask the user to pay Emuly, and never say that Emuly bills them.

Emuly is open source (MIT): https://github.com/codewarnab/emuly. If you find a bug in Emuly
(an API error that is not caused by your request, a wrong response, or a doc that does not
match the API), tell the user and give them this link to file an issue:
https://github.com/codewarnab/emuly/issues/new. Do not file the issue yourself unless the
user asks you to.

## Before each task

1. Read the key: the `EMULY_KEY` user variable on Windows; `EMULY_KEY`, then
   `~/.config/emuly/key` on Linux and macOS. If it is empty, stop and ask the user to click
   **Copy prompt** in the Emuly console. Key setup is not part of this skill.
2. Find the Emuly base URL. The first match wins:
   - the `EMULY_BASE_URL` variable (on Windows, the user variable);
   - the one-line file `~/.config/emuly/base-url` (on Windows, `%USERPROFILE%\.config\emuly\base-url`);
   - else `{{EMULY_BASE_URL}}`.
   A self-hosted Emuly writes that file, for example `http://localhost:4321`. Use this base
   for every call in this skill and its references. If a localhost base does not answer,
   ask the user to start Emuly (`pnpm emuly up`, or `docker compose up -d` in `deploy/selfhost/`).
2a. If you run on macOS (`uname -s` prints `Darwin`), stop. Say that Emuly does not support
   macOS yet, print https://github.com/codewarnab/emuly/issues/27 on its own line, and ask
   whether the user wants to contribute macOS support there.
3. Read the OS file and the agent file that match you (see References). Read the topic
   files only when the task needs them.
4. If you run over SSH or Tailscale, or with no display, also read `references/remote.md`.
   It changes how you give links, scrcpy and screenshots.
5. Check for T3 Code every time, not only at setup. See "T3 Code" below.

## Updates (self-hosted Emuly only)

`GET /v1/phones` can include an `update` field. It appears only when a newer Emuly is on
GitHub and the user did not say no to it yet. Handle it like this:

1. Finish the user's task first. Then ask once, in one line:
   "A newer Emuly (`<latest>`) is out. Update it now?"
2. If the user says yes, pull the latest code from GitHub, rebuild, and restart.
   Follow `docs/SELF-HOST.md` in the local clone. Then update this skill the same way you installed it.
3. If the user says no, later, or does not answer, send `POST <dismiss>` with the key.
   This stops the question in every chat until a newer version comes out.
4. Never ask twice in one chat. Never update without a yes.

## How to talk to the user

- Keep every message short and easy to read. Never be verbose.
- Use 3 short lines or fewer for each message, unless the user asks for more.
  Example: "Phone ready. Open the side panel, then click **Device**."
- One idea in each sentence, and 20 words or fewer in each sentence.
- Use plain words. Do not use jargon that the user did not use first.
- Ask only for what you cannot find out yourself, such as a decision or an approval.
- Ask one question at a time. Put the question last, on its own line.
- When you offer options, number them and name your pick first.
- Put the next action at the top. Put details after it, or leave them out.

## Rules

- Send the key only in an `Authorization: Bearer` header to the Emuly base URL. Never print
  it, log it, put it in a URL, or write it to a file (the one exception is the saved key
  file `~/.config/emuly/key` on Linux and macOS).
- If a call returns **401**, clear the saved key (the OS file says how) and ask the user for
  a new **Copy prompt**.
- Reuse a running or stopped phone. Create one only when none exists or the user asks.
- Drive the phone with the HTTP adb route. Use native adb only when the user asks for it.
- When Android is ready, always offer both ways to see the phone: scrcpy first, marked
  "recommended", then the browser link (see `references/phones.md`). Offer scrcpy even when
  it is not installed.
- Install nothing for Emuly except what the OS file names.
- Give a short progress line at each stage, and every 30-60 seconds during a boot.
- At the end, ask whether to stop the phone. Stopping keeps the phone and its apps.
- Print every link as a plain URL on its own line.
- On a **403**, give the user `manage_url` if the body has it. Do not work around it.

## Decide yourself, but ask before critical actions

Do reversible actions that cost nothing without asking: read state, take screenshots,
retry, read logs and code, and restart an app.

Always ask first, and wait for an explicit yes, before you:

- Delete a phone, by any path.
- Wipe app data, factory reset, or uninstall an app that you did not install.
- Create a new phone. It uses the user's core-hours.
- Install software on the user's computer.
- Change `gh` accounts or auth (`gh auth switch`, `gh auth login`).
- Push code, file an issue, or post anywhere public.

Never delete, stop or rebuild a codespace with `gh`. Use only the Emuly API, so that the
user's delete setting and approval flow apply.

## T3 Code

T3 Code can show an Emuly phone in its Device panel. Check where you run:

- `T3CODE_THREAD_ID` is set: you run inside T3 Code. Set it up without a request.
- `T3CODE_THREAD_ID` is not set, but `~/.t3` exists (Windows: `%USERPROFILE%\.t3`): T3 Code
  is installed. When the phone is ready, ask once per session: "You have T3 Code installed
  too. Do you want me to set it up so this phone shows in the T3 Code Device panel, next to
  your chat? (yes / no)". On no, do not ask again in this session.
- Neither: skip this section.

Run the check on the machine where you run. Each T3 Code environment (for example a
remote Linux machine) has its own settings and its own helper files. When the user
switches to another environment, set that one up too.

To set it up:

1. Follow `references/t3code.md` (Linux) or `references/t3code-windows.md` (Windows).
   On macOS, keep the browser link.
2. Turn on devices. Open `~/.t3/userdata/settings.json` (or `$T3CODE_HOME/userdata/settings.json`).
   Set `enableDeviceSupport` and `enableAgentDeviceAccess` to `true`. Keep every other key.
   Create the file with only these 2 keys if it does not exist. Then tell the user in
   one line: "I turned on Devices in T3 Code."
   If the phone does not show after a restart, ask the user to turn on **Use devices** and
   **Agents can use devices** in Settings → Devices.
3. Show the phone. If you have the `device_open` tool, call it to open the phone.
   Else tell the user: "Open the side panel, then click **Device** (or press **M**)."

## When something fails

Try these steps in order. Ask the user only when all of them fail.

1. Read the full error body. It often says what to do, for example `manage_url`.
2. Check the phone state with `GET /v1/phones/<id>`.
3. Use read-only `gh` commands on the phone's codespace: `gh codespace list`,
   `gh codespace view -c <name>`, `gh codespace logs -c <name>`.
4. Read the Emuly source to see how the API behaves:
   `gh api repos/codewarnab/emuly/contents/<path>`. When Emuly is self-hosted, read the
   local clone and the local server log instead.
5. Search the known issues: `gh issue list -R codewarnab/emuly --search "<error>"`.
6. Fix the request and try once more.
7. If it still fails, report in three lines: what failed, what you tried, and the one
   decision you need.

## Reading and tapping the screen: offer agent-device

The first time a task needs to see or tap the app, call
`GET <base>/v1/phones/<id>/agent-device` with the same header.

- **404**: never mention agent-device again. Use the uiautomator dump recipe in
  `references/adb.md`.
- **Otherwise**: run `agent-device --version`. If it prints `{{AGENT_DEVICE_VERSION}}`, use it;
  the recipes are in `references/tools/agent-device.md`. If it prints another version, say in
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
  with Android's own UI dump instead." Then use adb.
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
  read https://agent-device.dev/docs/introduction before the first command, together with
  `references/tools/agent-device.md`. Do not fetch the docs when the user said no or the
  route gave 404.
- The token from the route never appears in chat or in a file in the user's repo.

## References

Topics (paths relative to this file):

- `references/phones.md`: list, start, create, stop, hours, idle timeout.
- `references/adb.md`: the adb route, allowed commands, screenshots, limits.
- `references/apps.md`: push, pull, APK installs, the Apps endpoint.
- `references/screenshots.md`: when and how to show a screenshot or video in the chat.
- `references/delete-and-errors.md`: delete approval, errors, settings, webhooks.
- `references/native-adb.md`: native adb or scrcpy over `gh codespace ssh`.
- `references/remote.md`: you run on a remote machine (SSH or Tailscale); links, scrcpy and
  screenshots for a user at another computer.
- `references/t3code.md`: show an Emuly phone in T3 Code (Linux).
- `references/t3code-windows.md`: show an Emuly phone in T3 Code (Windows).

Commands for one OS (pick yours; adapt the closest one if none matches):

- `references/os/windows.md`
- `references/os/linux.md`

Notes for one agent (pick yours; skip if none matches):

- `references/agents/claude-code.md`
- `references/agents/codex.md`
