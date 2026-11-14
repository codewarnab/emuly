# Phones: choose, start, stop, hours

List the user's phones with `GET /v1/phones` before doing anything else. Each phone has an
`id`, a friendly `name`, `state`, `android_state`, `idle_timeout_min` and a `browser_url`.

Use the first rule that fits:

1. **A phone is running with Android ready.** Reuse it. Read it with
   `GET /v1/phones/<id>` and print `browser_url`.
2. **A phone exists but is stopped.** Start it with `POST /v1/phones/<id>/start`, then poll
   until Android is ready.
3. **No phone exists.** Create one with `POST /v1/phones` and body `{"idle_timeout_min":30}`
   (or `240` for a long task), then poll until Android is ready.

A start returns **202** with `{"id":"...","status":"starting"}`. Poll `GET /v1/phones/<id>`
until `state` is `running` and `android_state` is `ready`. Booting can take several
minutes. Send a short progress line every 30-60 seconds while it boots. Do not create a
second phone while the first one is booting.

After a start, `android_state` is `ready` a little before the home screen and its apps load.
When you give the link after a start, add this line: "Android is ready. The home screen and
apps can take a few more seconds to load." Before the first screenshot after a start, wait
until the home screen shows its apps (see `references/screenshots.md`).

Create only when the list is empty, or when the user explicitly asks for another phone.

The browser link `<base>/app/phones/<id>` is the way to watch and touch the phone. The same
link is in `browser_url`.

When Android is ready, put the link in the chat as a clickable link, with this line:
"Open this link to view the phone now: <browser_url>". Do not open the browser yourself.
Give the link again when you report that the task is done. If the user is signed out, the
link opens sign-in first and then returns to the phone page.

Always offer both ways to see the phone. scrcpy comes first, marked "recommended": its video
goes straight from the codespace to the user's computer over gh's SSH tunnel, and skips the
Emuly server. Offer scrcpy even when gh, adb or scrcpy is not installed: do not check for
the tools before the offer. Give both ways with this text:

```text
Two ways to see the phone:

1. scrcpy window on your computer (recommended)
   + Faster: the video skips the Emuly server. Smoother, with less delay.
   + Your keyboard, copy and paste, and file drag-and-drop work.
   - Needs gh, adb and scrcpy. I will ask before I install anything.

2. Browser link (ready now): <browser_url>
   + Nothing to install. Works on any computer.

Do you want me to open the scrcpy window?
```

Offer it once per session. Do not set it up until the user says yes. The steps are in
`references/native-adb.md`. On a remote machine, use the wording and steps in
`references/remote.md` instead: the window opens on the user's computer, not here.

## Hours and storage

- D1. The phone runs on the user's included GitHub Codespaces hours, not Emuly credit.
- D2. Free plans usually include 120 core-hours and 15 GB-month; Pro usually includes
  180 core-hours and 20 GB-month. Check `GET /v1/usage` when unsure.
- D3. A 4-core phone consumes about 4 core-hours per hour. 120 core-hours is about
  30 wall-clock hours; 180 is about 45.
- D4. Stopped phones still use storage. Codespaces delete stopped phones after the
  retention period; new phones keep 30 days.
- D5. Warn the user before creating many phones, and prefer reusing one.

## Work efficiently

- E1. Read `GET /v1/usage` before creating a phone when the user is near a limit.
- E2. Reuse a running or stopped phone before creating a new one.
- E3. Use `idle_timeout_min: 30` for a quick task and `240` for a long one.
- E4. Say what you are doing before each long step, then continue.
- E5. Send a progress line after listing, after start or creation, after boot, and after
  each app install. While Android boots, send one every 30-60 seconds.
- E6. At the end, ask whether to stop the phone, stop it, and give the browser link one
  last time.

