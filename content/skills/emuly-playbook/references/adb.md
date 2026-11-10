# Drive the phone with adb

Send ordinary adb arguments as a JSON array to `POST /v1/phones/<id>/adb`, as
`{"args":[...],"timeout_s":30}`. The runner adds the emulator serial itself. Never send a
single shell string: send one array item per argument.

Only these first arguments are accepted: `shell`, `exec-out`, `logcat`, `get-state`,
`get-serialno`, `get-devpath`, `uninstall`, `install`, `install-multiple`, `push`,
`pull`, `bugreport`, `emu` and `wait-for-device`. Everything else is rejected with a
message that names a replacement. The blocked list includes `sideload`, `backup`,
`restore`, `sync`, `keygen`, `ppp`, `forward`, `reverse`, `root`, `unroot`, `reboot`,
`connect`, `disconnect`, `kill-server`, `start-server`, `tcpip`, `usb`, and global
options such as `-s`, `-H`, `-P`, `-L`. Never send a runner-side path: file commands
upload bytes through the API, and the runner chooses its own temporary path.

Example argument arrays:

```json
["shell","input","tap","540","1200"]
["shell","input","swipe","900","1800","120","600","300"]
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

In `input text`, use `%s` for spaces. Escape shell metacharacters in the text, or avoid
them. `shell` commands run inside the user's emulator sandbox, so normal app and system
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

The phone must be running with Android ready. Otherwise the route returns **409** with a
message telling you to start it. A missing or stopped phone returns **404** or **409**;
do not create a phone to work around it.

**Screenshots:** the route detects `["exec-out","screencap","-p"]` and returns raw PNG bytes
instead of JSON. Save them to a file. Sending `Accept: image/png` also asks for raw bytes;
use it only with screenshot calls.

**Read the screen as text:** dump the UI hierarchy, then read the file back.

```json
["shell","uiautomator","dump","/sdcard/ui.xml"]
["exec-out","cat","/sdcard/ui.xml"]
```

It returns XML with one node per element, each carrying `text`, `resource-id`,
`content-desc` and `bounds="[x1,y1][x2,y2]"`. Tap the center of a node's bounds with
`["shell","input","tap","<x>","<y>"]`. Prefer this over guessing coordinates from a
screenshot. Dump again after the screen changes, because the old XML goes stale.
