# Screenshots and video in the chat

A screenshot in the chat lets the user see the phone without opening the phone page.
Showing one is optional. The phone link stays the main way to watch the phone.

## When to show one

Show a screenshot in the chat only in these cases:

- The user asks for a screenshot, a picture or a video.
- The task result is something the user must see, for example a layout, a dialog or a
  visual bug.
- A step failed, and the screen shows why (an error dialog, a crash, a sign-in wall).

Do not show a screenshot after every step. Screenshots that you take to check your own
work stay in the scratchpad. Read them yourself, and do not show them.

## The first screenshot after a start

The home screen and apps load a few seconds after `android_state` is `ready`. A screenshot
taken too early shows only the wallpaper, and the user thinks the phone has no apps.

- Wait about 15 seconds after `ready`, then take the screenshot.
- Look at it. If it shows only the wallpaper, wait 10 seconds and take it again.
- If you show it before the apps load, say: "The home screen is still loading. The apps
  will show in a few seconds."

## Where to save it

Save every file to the agent scratchpad or a temporary folder. Never save it to the user's
repository. Use a clear name, for example `emuly-<phone id>-login.png`.

## Ways to take it

Use the first way that you can.

1. **agent-device** (when it is set up, see `references/tools/agent-device.md`). No extra
   install.

   ```sh
   agent-device screenshot <scratchpad path>/emuly-<id>-result.png
   ```

   For a short video, start recording before the steps and stop after them:

   ```sh
   agent-device record start <scratchpad path>/emuly-<id>-task.mp4
   agent-device record stop
   ```

2. **The HTTP adb route** (always works, no install). Send
   `{"args":["exec-out","screencap","-p"]}` to `POST /v1/phones/<id>/adb` and save the raw
   PNG bytes. The commands for your shell are in the OS file, for example
   `references/os/windows.md`. The route has no video.

3. **Native adb** (only when the user already uses it, see `references/native-adb.md`):

   ```sh
   adb exec-out screencap -p > <scratchpad path>/emuly-<id>-result.png
   ```

## How to show it

- If your tools can send or attach a file to the chat, send the image or video with a
  one-line caption, for example "The login screen after the fix".
- Otherwise, give the full file path on its own line, so the user can open it.
- Give the phone link too if the user may want to see the live screen:
  "Open this link to view the phone now: <browser_url>".
- Never put the Emuly key or the agent-device token in a file name or a caption.
