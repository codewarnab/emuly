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

## Video: the recording route

Use this for a video. It needs no install and works on every phone. The phone records the
same video stream that the browser shows, so it adds almost no load. The MP4 has the phone's
sound as an Opus track. Send the same
`Authorization` header as for the other routes.

1. `POST <base>/v1/phones/<id>/recording/start` before the steps. The JSON body is optional:
   `{"max_s":600}` stops it after that many seconds (1 to 1800, default 600), and
   `{"quality":"saver"}` makes a smaller file (`auto`, `sharp` or `saver`).
   The reply comes when the first frame is recorded (`first_frame_ms`), up to 20 s after a
   cold boot. If `first_frame_ms` is `null`, check that Android is ready before the steps.
2. Do the steps.
3. `POST <base>/v1/phones/<id>/recording/stop`. The reply gives `frames`, `audio_packets` and `duration_ms`.
4. `GET <base>/v1/phones/<id>/recording/file` returns the MP4. Save it to the scratchpad, for
   example `emuly-<id>-task.mp4`, then show it as described below.

`audio_packets` counts 20 ms Opus packets; 0 means the phone's runner or boot is older than audio
support (a phone restart updates both). To check that an app plays a sound without a recording,
run `["shell","dumpsys","audio"]` through the adb route and look for `state:started` players.

`GET .../recording/status` shows the state. `POST .../recording/discard` deletes the file.
One recording runs at a time: a second start gets **409** `recording_busy`. A recording stops
by itself at `max_s`, at 1 GB, or when the phone stops; `file` still returns what it has.
If the codespace stopped during the recording, start the phone again: the runner then repairs
the file (`stop_reason` `recovered`), and `file` returns the video up to the stop.
A **503** `runner_update_required` means the phone runs an older runner: use agent-device
`record`, or tell the user that a phone restart updates it.

## Ways to take a screenshot

Use the first way that you can.

1. **agent-device** (when it is set up, see `references/tools/agent-device.md`). No extra
   install.

   ```sh
   agent-device screenshot <scratchpad path>/emuly-<id>-result.png
   ```

   agent-device can also record, if the recording route is not available:

   ```sh
   agent-device record start <scratchpad path>/emuly-<id>-task.mp4
   agent-device record stop
   ```

2. **The HTTP adb route** (always works, no install). Send
   `{"args":["exec-out","screencap","-p"]}` to `POST /v1/phones/<id>/adb` and save the raw
   PNG bytes. The commands for your shell are in the OS file, for example
   `references/os/windows.md`.

3. **Native adb** (only when the user already uses it, see `references/native-adb.md`):

   ```sh
   adb exec-out screencap -p > <scratchpad path>/emuly-<id>-result.png
   ```

## How to show it

- If your tools can send or attach a file to the chat, send the image or video with a
  one-line caption, for example "The login screen after the fix".
- On a remote machine, a path here is no use to the user: follow `references/remote.md`
  section 5 (Taildrop over Tailscale, or one `scp` command).
- Otherwise, give the full file path on its own line, so the user can open it.
- Give the phone link too if the user may want to see the live screen:
  "Open this link to view the phone now: <browser_url>".
- Never put the Emuly key or the agent-device token in a file name or a caption.
