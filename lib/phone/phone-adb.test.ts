import { test } from "node:test";
import assert from "node:assert/strict";
import { adbArguments, adbResult, adbTimeout, isScreencap } from "./phone-adb-contract.ts";

test("adb accepts only the allowlisted commands", () => {
  const allowed = [
    ["shell", "input", "tap", "540", "1200"],
    ["shell", "input", "swipe", "900", "1800", "120", "600", "300"],
    ["shell", "input", "text", "hello%sworld"],
    ["shell", "input", "keyevent", "KEYCODE_HOME"],
    ["exec-out", "screencap", "-p"],
    ["exec-out", "cat", "/sdcard/Download/notes.txt"],
    ["shell", "dumpsys", "battery"],
    ["shell", "echo", "hello", ">", "/sdcard/Download/notes.txt"],
    ["shell", "am", "start", "-n", "com.example.app/.MainActivity"],
    ["shell", "pm", "list", "packages"],
    ["logcat", "-d", "-t", "200"],
    ["logcat", "-c"],
    ["get-state"],
    ["get-serialno"],
    ["get-devpath"],
    ["uninstall", "com.example.app"],
  ];
  for (const args of allowed) assert.deepEqual(adbArguments(args), args);
});

test("adb rejects device selectors, server options and host-level commands", () => {
  const rejected = [
    ["-s", "emulator-5554", "shell", "id"],
    ["shell", "input", "tap", "-s"],
    ["-H", "127.0.0.1", "shell", "id"],
    ["-P", "5037", "shell", "id"],
    ["-L", "tcp:1234", "shell", "id"],
    ["-sfoo", "shell", "id"],
    ["-Llocalhost:1234", "shell", "id"],
    ["connect", "127.0.0.1:5555"],
    ["disconnect"],
    ["kill-server"],
    ["start-server"],
    ["root"],
    ["unroot"],
    ["reboot"],
    ["remount"],
    ["disable-verity"],
    ["tcpip", "5555"],
    ["usb"],
    ["forward", "tcp:5555", "tcp:5555"],
    ["reverse", "tcp:5555", "tcp:5555"],
    ["unknown-command"],
  ];
  for (const args of rejected) assert.throws(() => adbArguments(args), /not allowed|Start with/);
});

test("adb rejects every file transfer and host filesystem command", () => {
  const rejected = [
    ["pull", "/sdcard/x"],
    ["pull", "/sdcard/x", "/workspaces/app/runner/runner.mjs"],
    ["push", "local.apk", "/sdcard/Download/local.apk"],
    ["push", "/workspaces/app/secret", "/sdcard/x"],
    ["install", "local.apk"],
    ["install-multiple", "a.apk", "b.apk"],
    ["install-multi-package", "a.apk", "b.apk"],
    ["sideload", "update.zip"],
    ["emu", "kill"],
    ["backup", "-f", "backup.ab"],
    ["restore", "backup.ab"],
    ["bugreport", "/tmp/report.zip"],
    ["sync", "/sdcard/x"],
    ["keygen", "/tmp/key"],
    ["ppp", "10.0.0.1"],
    ["wait-for-device"],
    ["wait-for-usb-device"],
  ];
  for (const args of rejected) assert.throws(() => adbArguments(args), /not allowed/);
});

test("adb error messages name the replacement route", () => {
  assert.throws(() => adbArguments(["install", "app.apk"]), /POST \/v1\/phones\/<id>\/app-installs/);
  assert.throws(() => adbArguments(["pull", "/sdcard/x"]), /exec-out cat \/sdcard\//);
  assert.throws(() => adbArguments(["push", "x", "/sdcard/x"]), /shell echo|app-installs/);
});

test("logcat refuses file and rotation options", () => {
  const rejected = [
    ["logcat", "-f", "/sdcard/log.txt"],
    ["logcat", "-f/sdcard/log.txt"],
    ["logcat", "--file", "/sdcard/log.txt"],
    ["logcat", "--file=/sdcard/log.txt"],
    ["logcat", "-r", "1000"],
    ["logcat", "-r1000"],
    ["logcat", "-n", "5"],
    ["logcat", "-n5"],
    ["logcat", "--rotate-kmsg"],
  ];
  for (const args of rejected) assert.throws(() => adbArguments(args), /logcat/);
});

test("adb rejects malformed arguments and payloads", () => {
  for (const value of [undefined, null, "shell input tap 1 2", [], ["shell", 1], ["shell", ""], [""]])
    assert.throws(() => adbArguments(value));
  assert.throws(() => adbArguments(Array(65).fill("shell")), /at most/);
});

test("adb timeout defaults, caps and rejects fractional values", () => {
  assert.equal(adbTimeout(undefined), 30);
  assert.equal(adbTimeout(1), 1);
  assert.equal(adbTimeout(120), 120);
  for (const value of [0, -1, 121, 1.5, "30", null]) assert.throws(() => adbTimeout(value), /timeout_s/);
});

test("screenshot detection only matches exec-out screencap -p", () => {
  assert.equal(isScreencap(["exec-out", "screencap", "-p"]), true);
  assert.equal(isScreencap(["shell", "screencap", "-p"]), false);
  assert.equal(isScreencap(["exec-out", "screencap", "-p", "extra"]), false);
});

test("adb response parsing rejects malformed runner payloads", () => {
  assert.deepEqual(adbResult({ exit_code: 0, stdout: "ok", stderr: "" }), { exit_code: 0, stdout: "ok", stderr: "" });
  for (const value of [null, {}, { exit_code: "0", stdout: "", stderr: "" }, { exit_code: 0, stdout: 1, stderr: "" }])
    assert.throws(() => adbResult(value));
});
