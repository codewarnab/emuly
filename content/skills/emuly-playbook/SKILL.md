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

## Which files to read (strict)

**STOP. Do not read any other file in this skill yet.**

This skill has many files. Most of them are NOT for you. Each extra file wastes the
user's context and makes your work worse. Follow these rules exactly:

1. Do NOT list, glob, search or open the `references/` folder to see what is in it.
2. Do NOT read a file "to be safe" or "for context".
3. Read a file ONLY when a row below matches you NOW. Read 1 file for each matching row.
4. Never read a file for another OS. Never read a file for another agent.
5. When this skill says "read X", read only X. Do not read the files next to X.
6. If you are not sure that a row matches, do not read the file. Continue the task.

**At the start of a task, read at most 2 files:** 1 machine file, and 1 agent file if one matches.
Read them again only when the user changes the machine, the OS or the agent.
Paths are relative to this file.

At the start of a task:

| If | Read |
|---|---|
| You run on Windows | `references/machine/windows.md` |
| You run on Linux | `references/machine/linux.md` |
| You run on macOS | `references/machine/macos.md` |
| No machine file matches your OS | the closest machine file |
| You run over SSH or Tailscale, or with no display | also `references/machine/remote.md` |
| You are Claude Code | `references/agents/claude-code.md` |
| You are Codex | `references/agents/codex.md` |
| Another agent | no agent file |

Only when the task needs it:

| When | Read |
|---|---|
| List, start, create, stop a phone; hours; idle timeout | `references/tasks/phones.md` |
| Run adb, or read the UI tree | `references/tasks/adb.md` |
| Install an APK, push or pull a file | `references/tasks/apps.md` |
| Take a screenshot, or record the screen | `references/tasks/screenshots.md` |
| Add captions to a video, or a before/after video for a PR | `references/tasks/annotate.md` |
| Delete a phone | `references/tasks/delete-and-errors.md` |
| An error code you do not know | `references/tasks/errors.md`, only that code's section |
| The user asks for native adb or scrcpy, or hot reload with flutter, expo or Android Studio | `references/tasks/native-adb.md` |
| The app calls a server (always check before a test) | `references/tasks/local-servers.md` |
| Phone traffic must leave from the user's computer, network or a proxy they name | `references/tasks/proxy.md` |
| See or tap the screen for the first time | `references/tasks/agent-device.md` |
| Set up T3 Code (see "T3 Code") | `references/t3code/<your OS>.md`, one file only |
| The `GET /v1/phones` reply has `skill_update`, `update` or `network_hint` | `references/notices.md` |

## Before each task

1. Read the key: the `EMULY_KEY` user variable on Windows; `EMULY_KEY`, then
   `~/.config/emuly/key` on Linux and macOS. If it is empty, stop and ask the user to click
   **Copy prompt** in the Emuly console. Key setup is not part of this skill.
   On a self-hosted Emuly (a localhost base), the key is optional. The local server accepts
   any key, also one from another Emuly server, and acts as the `gh` account that runs it.
   Without a key, send `Origin: <base URL>` with each call.
2. Find the Emuly base URL. The first match wins:
   - the `EMULY_BASE_URL` variable (on Windows, the user variable);
   - the one-line file `~/.config/emuly/base-url` (on Windows, `%USERPROFILE%\.config\emuly\base-url`);
   - else `{{EMULY_BASE_URL}}`.
   A self-hosted Emuly writes that file, for example `http://localhost:4321`. Use this base
   for every call in this skill and its references. If a localhost base does not answer,
   ask the user to start Emuly (`pnpm emuly up`, or `docker compose up -d` in `deploy/selfhost/`).
3. Read the files for your machine and agent (see "Which files to read").
   On macOS, `DISPLAY` is not used: a Mac is remote only when `SSH_CONNECTION` is set.
4. Check for T3 Code every time, not only at setup. See "T3 Code" below.

## Updates and notices

This skill is version `{{EMULY_SKILL_VERSION}}`. Send the header
`X-Emuly-Skill: {{EMULY_SKILL_VERSION}}` with every `GET /v1/phones`
(your machine file shows how). If the reply has a `skill_update`, `update` or
`network_hint` field, or a call returns `runner_update_required`, read
`references/notices.md`.

## When a call fails

Every error reply has `error` (a stable code) and `message`. Many also have:
- `fix`: the next call to make, with the ids filled in. Make it yourself. If it has `then`,
  make that call next. If it has `repeat_until`, repeat it every `every_s` seconds, at most `max_tries` times.
  `{"same_request": true}` means: send the same call again.
- `retry_after` and `max_retries`: wait that many seconds; stop after that many tries.
- `needs_user: true`: only the user can do this step. Ask them in one line, with `user_url` if there is one.
- `use_cli`: how to get the Emuly CLI. If Node 22+ is installed, run `install`, then `then`. Otherwise ignore it.
- `docs`: a link to the section for this code in `references/tasks/errors.md`. Read it only when `fix` is not enough.

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
- After the first setup, when the first phone is ready, send the "what I can do" list from
  step 4 of the setup prompt once. Skip it if you already sent it in this chat. This one
  message may be longer than 3 lines.

## Rules

- Send the key only in an `Authorization: Bearer` header to the Emuly base URL. Never print
  it, log it, put it in a URL, or write it to a file (the one exception is the saved key
  file `~/.config/emuly/key` on Linux and macOS).
- If a call returns **401**, clear the saved key (the OS file says how) and ask the user for
  a new **Copy prompt**. On a self-hosted (localhost) base, never clear the key: the same key
  can still work on another Emuly server. Ask the user to restart the local server instead.
- A **504** with `"error": "timeout"` means the phone was slow, often just after boot. Wait
  `retry_after` seconds (also in the `Retry-After` header), then try again. Do not stop the phone.
- Reuse a running or stopped phone. Create one only when none exists or the user asks.
- Drive the phone with the HTTP adb route. Use native adb only when the user asks for it.
- Send `X-Emuly-Note: <3-10 words on what the call does>` with each adb, screenshot and
  recording call. The user reads it in the activity log. See `references/tasks/adb.md`.
- When Android is ready, always offer both ways to see the phone: scrcpy first, marked
  "recommended", then the browser link (see `references/tasks/phones.md`). Offer scrcpy even when
  it is not installed. First check where you run (local, remote over Tailscale, or plain
  SSH). Then give only the scrcpy commands for that case, with real names filled in.
- The browser link is always the full phone link in `browser_url`, such as
  `<base>/app/phones/<id>`. Never give only the base URL.
- Install nothing for Emuly except what the OS file names.
- Give a short progress line at each stage, and every 30-60 seconds during a boot.
- At the end, ask whether to stop the phone. Stopping keeps the phone and its apps.
- Print every link as a plain URL on its own line.
- On a **403**, give the user `manage_url` if the body has it. Do not work around it.

## Phone types (screen presets)

`POST /v1/phones` takes an optional `device_preset`. The values are `generic` (default),
`pixel_9`, `pixel_9_pro`, `small_phone`, `galaxy_size` and `pixel_tablet`. All use the same
Android 16 image. Only the screen size and density change. `GET /v1/phones` shows `device_preset`.

- If the user names a phone type, send the matching value. For example "a tablet" is
  `pixel_tablet`, and "a Samsung" or "a Galaxy" is `galaxy_size`.
- If the user names no type, do not ask first. Make a `generic` phone. Then tell the user
  in one short line: "I made a generic phone. I can also make a Pixel 9, a Pixel 9 Pro, a
  small phone, a Galaxy-size screen or a tablet."
- The type is fixed when the phone is made. A different type needs a new phone.
- `galaxy_size` copies only the screen. Do not say that it is a real Samsung phone.

## Decide yourself, but ask before critical actions

Do reversible actions that cost nothing without asking: read state, take screenshots,
retry, read logs and code, and restart an app.

Always ask first, and wait for an explicit yes, before you:

- Delete a phone, by any path.
- Wipe app data, factory reset, or uninstall an app that you did not install.
- Create a new phone. It uses the user's core-hours.
- Install software on the user's computer. This includes the GitHub CLI for a link.
- Change `gh` accounts or auth (`gh auth switch`, `gh auth login`).
- Link a phone port to a target that is not localhost (`emuly link ... --to`), or to a database port.
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

Run the check on the machine where you run. To set it up, read only
`references/t3code/<your OS>.md` (`linux`, `windows` or `macos`).

## Check the app's server before you test it

An app on the phone cannot reach a server on the user's laptop, LAN or tailnet by itself.
On the phone, `localhost` is the phone. Do not change the app's server code.

Do this check before you test any app, even when the user does not mention a server. Do not
wait for the app to fail.

1. Find the server address. Look in the project's env files and build config. When you install
   with `POST /v1/phones/<id>/app-installs`, also read `serverUrls` in the finished operation.
2. If an address is loopback, `10.0.2.2`, a private LAN address or a `.ts.net` name, test it
   with `GET /v1/phones/<id>/net-check?target=host:port`, and start a link if the `fix` says so.
3. Tell the user in one line, for example: "Your app calls localhost:3000. I linked it to your computer."

`references/tasks/local-servers.md` has the full steps: where to look, links (`emuly link`), and net-check.

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

## Reading and tapping the screen

The first time a task needs to see or tap the app, read `references/tasks/agent-device.md`.
