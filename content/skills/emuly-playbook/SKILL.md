---
name: emuly-playbook
description: Run and drive Android phones with Emuly (emulators in the user's GitHub Codespaces) over its HTTP API. Use when the user asks to start, reuse, control, screenshot, install apps on, test on, stop, or delete an Emuly phone.
---

# Emuly playbook

Emuly runs an Android emulator in the user's own GitHub Codespace, on the hours in their
GitHub plan. Never ask the user to pay Emuly, and never say that Emuly bills them.

## Before each task

1. Read the key from the `EMULY_KEY` user variable. If it is empty, stop and ask the user
   to click **Copy prompt** in the Emuly console. Key setup is not part of this skill.
2. The Emuly base URL is `{{EMULY_BASE_URL}}`.
3. Read the OS file and the agent file that match you (see References). Read the topic
   files only when the task needs them.

## Rules

- Send the key only in an `Authorization: Bearer` header to the Emuly base URL. Never print
  it, log it, put it in a URL, or write it to a file.
- If a call returns **401**, clear `EMULY_KEY` and ask the user for a new **Copy prompt**.
- Reuse a running or stopped phone. Create one only when none exists or the user asks.
- Drive the phone with the HTTP adb route. Use native adb only when the user asks for it.
- Install nothing for Emuly except what the OS file names.
- Give a short progress line at each stage, and every 30-60 seconds during a boot.
- At the end, ask whether to stop the phone. Stopping keeps the phone and its apps.
- Print every link as a plain URL on its own line.
- On a **403**, give the user `manage_url` if the body has it. Do not work around it.

## References

Topics (paths relative to this file):

- `references/phones.md`: list, start, create, stop, hours, idle timeout.
- `references/adb.md`: the adb route, allowed commands, screenshots, limits.
- `references/apps.md`: push, pull, APK installs, the Apps endpoint.
- `references/delete-and-errors.md`: delete approval, errors, settings, webhooks.
- `references/native-adb.md`: native adb or scrcpy over `gh codespace ssh`.

Commands for one OS (pick yours; adapt the closest one if none matches):

- `references/os/windows.md`

Notes for one agent (pick yours; skip if none matches):

- `references/agents/claude-code.md`
