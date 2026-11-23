# Drive the phone with adb

> Read this file only if the task runs adb or reads the UI tree. If not, stop reading now, and do not read the
> other files in this folder.

Send ordinary adb arguments as a JSON array to `POST /v1/phones/<id>/adb`, as
`{"args":[...],"timeout_s":30}`. The runner adds the emulator serial itself. Never send a
single shell string: send one array item per argument.

Only these first arguments are accepted: `shell`, `exec-out`, `logcat`, `get-state`,
`get-serialno`, `get-devpath`, `uninstall`, `install`, `install-multiple`, `push`,
`pull`, `bugreport`, `emu`, `wait-for-device` and `text`. Everything else is rejected with a
message that names a replacement. The blocked list includes `sideload`, `backup`,
`restore`, `sync`, `keygen`, `ppp`, `forward`, `reverse`, `root`, `unroot`, `reboot`,
`connect`, `disconnect`, `kill-server`, `start-server`, `tcpip`, `usb`, and global
options such as `-s`, `-H`, `-P`, `-L`. Never send a runner-side path: file commands
upload bytes through the API, and the runner chooses its own temporary path.

**Say what each call does.** Send the header `X-Emuly-Note` with each adb, screenshot and
recording call. The user sees the note in the phone's activity log as `[agent] <note>`, and a
click shows the command. Rules for the note:

- Use 3 to 10 plain words in the present tense. Say what the call does, not why.
  For example "Open Wi-Fi settings", "Type the test email", "Check the toast after Save".
- Never put secrets, passwords or typed personal data in the note.
- Headers carry only ASCII. Percent-encode other text, for example with `encodeURIComponent`.
- The note is optional and only for display. Emuly cuts it to 80 characters.

```bash
curl -sS -X POST "$base/v1/phones/$id/adb" -H "Authorization: Bearer $EMULY_KEY"   -H "Content-Type: application/json" -H "X-Emuly-Note: Open Wi-Fi settings"   -d '{"args":["shell","am","start","-a","android.settings.WIFI_SETTINGS"]}'
```

Example argument arrays:

```json
["shell","input","tap","540","1200"]
["shell","input","swipe","900","1800","120","600","300"]
["text","hello world"]
["shell","input","text","hello%sworld"]
["shell","input","keyevent","KEYCODE_HOME"]
["shell","dumpsys","battery"]
["logcat","-d","-t","200"]
["shell","am","start","-n","com.example.app/.MainActivity"]
["shell","pm","list","packages"]
["wait-for-device"]
["emu","geo","fix","-122.084","37.422"]
["emu","sms","send","15551234567","Your code is 123456"]
["emu","power","capacity","8"]
["emu","power","ac","off"]
["emu","network","speed","gprs"]
["emu","finger","touch","0"]
["emu","rotate"]
```

**Type text:** use `["text","<text>"]`. It types any Unicode text, such as `"Grüße, नमस्ते 👋"`,
into the focused field. Spaces and symbols need no escaping, because no shell reads the text.
Tap the field first. The text replaces the phone's clipboard. Line breaks are rejected: type each
line, then send `["shell","input","keyevent","KEYCODE_ENTER"]`. The limit is 8192 UTF-8 bytes.
A runner older than this feature rejects `text`; then update the runner.

`["shell","input","text",...]` still works, but it types ASCII only. In it, use `%s` for spaces,
and escape shell metacharacters or avoid them. `shell` commands run inside the user's emulator sandbox, so normal app and system
inspection commands work.

Read logs with `["logcat","-d","-t","200"]`. The `-f`, `--file`, `-r`, `-n` and
`--rotate-*` options are rejected because they write or rotate files on the device.

Text replies are JSON:

```json
{"exit_code":0,"stdout":"...","stderr":""}
```

A non-zero `exit_code` is a command result, not an HTTP failure. Read `stderr` before
retrying. The default timeout is 30 seconds. It is capped at 120 seconds, except
`install`, `install-multiple` and `bugreport`, which allow up to 300. Normal JSON output
is capped at 5 MB; narrow the command if it is larger. One adb call runs at a time per
phone; a second one gets **409** and should be retried after the first finishes.

**An error says whether the command ran.** Every adb error has `error`, `message` and `ran`:

- `ran: false`: adb did not start (for example **409** `phone_conflict`, or bad input). A retry is safe.
- `ran: true`: adb ran, but the result could not come back (for example **413** `output_too_large`).
- `ran: "unknown"`: the command may have run (**504** `adb_timeout`, or a lost reply with
  **502** `adb_failed`). Do not repeat an action blindly. Check the phone first, for example
  with a screenshot, or retry with the same `Idempotency-Key`.

**Retry key:** send an `Idempotency-Key` header (1 to 100 letters, digits, `_ . : -`) with an
action that must not run twice, such as a `tap`, `swipe`, `text` or `install`. Use a new key
for each new action. A retry with the same key within 10 minutes does not run the command
again: it returns the first result with `"replayed": true`. A first call that did not start
(`ran: false`) is not kept, so a retry with its key runs the command.

The phone must be running with Android ready. Otherwise the route returns **409** with a
message telling you to start it. A missing or stopped phone returns **404** or **409**;
do not create a phone to work around it.

**Screenshots:** the route detects `["exec-out","screencap","-p"]` and returns raw PNG bytes
instead of JSON. Save them to a file. Sending `Accept: image/png` also asks for raw bytes;
use it only with screenshot calls. For a smaller image, use `GET /v1/phones/<id>/screenshot?scale=0.5`
(see `references/tasks/screenshots.md`).

**Read the screen as text:** `GET <base>/v1/phones/<id>/ui` with the same header. It returns
short JSON, not XML:

```json
{"package":"com.example","rotation":0,"count":2,"tries":1,"ms":900,"nodes":[
  {"text":"Sign in","id":"com.example:id/login","class":"Button","bounds":[100,300,980,420],"tap":[540,360],"flags":["clickable"]},
  {"desc":"Back","class":"ImageButton","bounds":[0,0,100,100],"tap":[50,50],"flags":["clickable"]}]}
```

- Each node has `text`, `desc` (content-desc), `id` (resource-id), `class`, `bounds`
  `[x1,y1,x2,y2]` and `tap` `[x,y]`, the centre. Fields that are empty are left out.
- `flags` can hold `clickable`, `long_clickable`, `scrollable`, `checkable`, `checked`,
  `selected`, `focused`, `password` and `disabled`.
- Only useful nodes come back: nodes with text, a description, an id or an action. `?all=1`
  returns every node, with the layout containers.
- Tap a node with `["shell","input","tap","<x>","<y>"]` and its `tap` values. Prefer this over
  guessing coordinates from a screenshot. Read the tree again after the screen changes.
- The first dump after a screen change often fails with "null root node", because the window
  is not ready. The route retries up to 4 times (`tries` shows how many it needed).
- A `503` with `ui_unavailable` means every try failed. The screen may still be changing, or
  another UiAutomation tool (agent-device) runs. Wait 1 s and retry once, then use a screenshot.
- A `503` with `runner_update_required` means the phone's runner is older than this route.
  Send `POST /v1/phones/<id>/apps/update` and repeat it until it returns `{"status":"ready"}`, then retry.
  If you cannot update it, use the adb recipe below.

The same data through the adb route, as XML (older runners). Retry the dump once if it prints
"null root node":

```json
["shell","uiautomator","dump","/sdcard/ui.xml"]
["exec-out","cat","/sdcard/ui.xml"]
```

`uiautomator dump` does not show the buttons of a Jetpack Compose dialog. The dialog's
nodes are missing from the XML, so a tap on them is a guess from a screenshot. For a
Compose app, use agent-device (`references/tasks/agent-device.md`): its snapshot reads
the Compose semantics tree and gives each button a ref to tap.

**Open a file with an app:** push the file, then send a VIEW intent with its type.

```json
["push","@file0","/sdcard/Download/report.pdf"]
["shell","am","start","-a","android.intent.action.VIEW","-t","application/pdf","--grant-read-uri-permission","-d","file:///sdcard/Download/report.pdf"]
```

Add `-n <package>/<activity>` or `-p <package>` to pick the app. Without it, Android may show
a chooser: read the screen and tap the app. If the app shows an empty screen or a
permission error, it cannot read a `file://` path. Then use a `content://` URI from the
media store:

```json
["shell","content","query","--uri","content://media/external/file","--projection","_id","--where","_data='/sdcard/Download/report.pdf'"]
["shell","am","start","-a","android.intent.action.VIEW","-t","application/pdf","--grant-read-uri-permission","-d","content://media/external/file/<_id>"]
```

If the query returns no row, the media store has not seen the file yet. Wait a few seconds
and query again.
