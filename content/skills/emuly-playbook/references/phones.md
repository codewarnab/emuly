# Phones: choose, start, stop, hours

List the user's phones with `GET /v1/phones` before doing anything else. Each phone has an
`id`, a friendly `name`, `state`, `android_state`, `idle_timeout_min`, `idle_stop_at` and a `browser_url`.
`idle_stop_at` is the time Emuly stops a running phone if nothing uses it (null when no idle stop applies).
Any phone call (adb, screenshot, input) moves it later.

Use the first rule that fits:

1. **A phone is running with Android ready.** Reuse it. Read it with
   `GET /v1/phones/<id>` and print `browser_url`.
2. **A phone exists but is stopped.** Start it with `POST /v1/phones/<id>/start`, then wait
   until Android is ready (see below).
3. **No phone exists.** Create one with `POST /v1/phones` and body `{"idle_timeout_min":30}`
   (or `240` for a long task), then wait until Android is ready (see below).

A start returns **202** with `status: "starting"` and a `wait` path. Call
`GET /v1/phones/<id>?wait_for=ready&timeout_s=60`. The server holds the request and answers
when Android is ready, when the start fails, or after 60 s. The answer has
`wait: {for, done, failed, timed_out}`:

- `done: true`: the phone is running and Android is ready.
- `timed_out: true`: it still boots. Send a short progress line, then call the same URL again.
- `failed: true`: read `state` and `android_state`, and tell the user.

Booting can take several minutes. Do not create a second phone while the first one is booting.

## Stop

`POST /v1/phones/<id>/stop` returns **202** at once with `status: "stopping"`. Android then
saves its state, and GitHub stops the codespace. This takes about 1-2 minutes. To know when
it ends, call `GET /v1/phones/<id>?wait_for=stopped&timeout_s=120`. Tell the user that the stop
started, and do not wait for it unless the next step needs a stopped phone. A webhook gets
`phone.stopped` when it ends (see `references/delete-and-errors.md`).

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
the tools before the offer, and never install them before a yes.

### Check the situation first

Before you send the offer, find out where you run and where the user sits. Do not ask the
user for this. Check it yourself, once per session:

1. **Where you run.** Run the check in `references/remote.md` section 1. It tells you if
   you are local or remote, if the link is over Tailscale, and the name and OS of the user's
   computer.
2. **The codespace name.** If `gh` works here, find the phone's codespace now
   (`references/native-adb.md` step 2) and put the real name in the commands. If `gh` does
   not work here, use the lookup form in case A below.
3. **The port.** Use 5555. If it is in use where the tunnel runs, use 5556.

Then pick exactly one case and give only its commands. Never give the commands of a case
that does not match.

**A. You run on the user's computer (local).** The user runs all 3 commands there. Use the
syntax of their shell: PowerShell on Windows, sh on Linux and macOS.

```powershell
gh codespace ssh -c <codespace-name> -- -N -L 5555:127.0.0.1:5555
adb connect 127.0.0.1:5555
scrcpy -s 127.0.0.1:5555
```

If you do not know `<codespace-name>`, write this in its place. In sh, use `$(...)`:
`(gh codespace list --json name,displayName -q '.[] | select(.displayName=="<id>") | .name')`

**B. You run on a remote machine, over Tailscale.** You start the tunnel here
(`references/remote.md` section 4, "Over Tailscale"). The user runs one command on
`<computer name>`:

```sh
scrcpy --tcpip=<this machine's Tailscale name>:5555
```

**C. You run on a remote machine, over plain SSH.** You start the tunnel here on loopback.
The user runs 2 commands on their computer, each in its own terminal:

```sh
ssh -N -L 5555:127.0.0.1:5555 <user>@<host>
scrcpy --tcpip=127.0.0.1:5555
```

In B and C, the tunnel runs only after the user says yes, so write "Say yes and I will start
the tunnel" above the user's commands. Add the scrcpy install line for the user's OS from
`references/remote.md` section 4.

### The offer

- `<browser_url>` is the full phone link from `GET /v1/phones/<id>`, for example
  `https://emuly.vercel.app/app/phones/phone-copper-robin`. Never give only the base URL
  (`https://emuly.vercel.app`): it opens the phone list, not this phone.
- In remote cases, write "on your computer (<computer name>)" in option 1.

```text
Two ways to see the phone:

1. scrcpy window on your computer (recommended)
   + Faster: the video skips the Emuly server. Smoother, with less delay.
   + Your keyboard, copy and paste, and file drag-and-drop work.
   - Needs scrcpy (and gh and adb in case A). I will ask before I install anything.
   Say yes and I will open it. To run it yourself:
   <the commands of the one matching case, in a code block>

2. Browser link (ready now):
   <browser_url>
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

