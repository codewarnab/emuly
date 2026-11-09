import { test } from "node:test";
import assert from "node:assert/strict";
import { adbArguments, adbResult, adbTimeout, isDownload, isScreencap } from "./phone-adb-contract.ts";

test("adb accepts the allowlisted commands and the file commands", () => {
  const allowed: [string[], number?][] = [
    [["shell", "input", "tap", "540", "1200"]],
    [["shell", "input", "swipe", "900", "1800", "120", "600", "300"]],
    [["shell", "input", "text", "hello%sworld"]],
    [["shell", "input", "keyevent", "KEYCODE_HOME"]],
    [["exec-out", "screencap", "-p"]],
    [["exec-out", "cat", "/sdcard/Download/notes.txt"]],
    [["shell", "dumpsys", "battery"]],
    [["logcat", "-d", "-t", "200"]],
    [["logcat", "-c"]],
    [["get-state"]],
    [["get-serialno"]],
    [["get-devpath"]],
    [["uninstall", "com.example.app"]],
    [["wait-for-device"]],
    [["pull", "/sdcard/x.png"]],
    [["bugreport"]],
    [["install", "-r", "@file0"], 1],
    [["install", "-t", "-g", "-d", "--abi", "arm64-v8a", "@file0"], 1],
    [["install-multiple", "-r", "@file0", "@file1"], 2],
    [["push", "@file0", "/sdcard/Download/x.txt"], 1],
    [["push", "@file0", "/data/local/tmp/x.bin"], 1],
  ];
  for (const [args, files = 0] of allowed) assert.deepEqual(adbArguments(args, files), args);
});

test("adb rejects device selectors, global options and host-level commands", () => {
  const rejected = [
    ["-s", "emulator-5554", "shell", "id"],
    ["shell", "input", "tap", "-s"],
    ["-H", "127.0.0.1", "shell", "id"],
    ["-P", "5037", "shell", "id"],
    ["-L", "tcp:1234", "shell", "id"],
    ["-sfoo", "shell", "id"],
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
    ["sideload", "update.zip"],
    ["backup", "-f", "backup.ab"],
    ["restore", "backup.ab"],
    ["sync", "/sdcard/x"],
    ["keygen", "/tmp/key"],
    ["ppp", "10.0.0.1"],
    ["install-multi-package", "a.apk", "b.apk"],
    ["unknown-command"],
  ];
  for (const args of rejected) assert.throws(() => adbArguments(args), /not allowed|Start with/);
});

test("adb error messages name what to use instead", () => {
  assert.throws(() => adbArguments(["sideload", "update.zip"]), /install.*@file0|app-installs/);
  assert.throws(() => adbArguments(["backup", "-f", "x"]), /exec-out cat/);
  assert.throws(() => adbArguments(["forward", "tcp:1", "tcp:2"]), /serial and adb server are fixed/);
  assert.throws(() => adbArguments(["reboot"]), /POST \/v1\/phones\/<id>\/start/);
  assert.throws(() => adbArguments(["connect", "1.2.3.4"]), /pins its own emulator serial/);
});

test("file placeholders must be uploaded and referenced", () => {
  assert.throws(() => adbArguments(["install", "-r", "@file0"]), /not uploaded/);
  assert.throws(() => adbArguments(["push", "@file1", "/sdcard/x"], 1), /not uploaded/);
  assert.throws(() => adbArguments(["push", "@file0", "/sdcard/x"], 2), /file1 is not referenced/);
  assert.throws(() => adbArguments(["shell", "echo", "@file0"], 1), /only supported for install/);
  assert.throws(() => adbArguments(["install-multiple", "-r", "@file0", "@file1"], 1), /not uploaded/);
  assert.throws(() => adbArguments(["push", "@file0", "/sdcard/x"], 21), /at most 20 files/);
});

test("push accepts only safe device paths and a single uploaded file", () => {
  assert.throws(() => adbArguments(["push", "/workspaces/app/secret", "/sdcard/x"], 1), /placeholder/);
  assert.throws(() => adbArguments(["push", "@file0", "/data/x"], 1), /\/sdcard\/ or \/data\/local\/tmp\//);
  assert.throws(() => adbArguments(["push", "@file0", "/sdcard/../data/x"], 1), /cannot contain \.\./);
  assert.throws(() => adbArguments(["push", "@file0", "/data/local/tmp/../x"], 1), /cannot contain \.\./);
  assert.throws(() => adbArguments(["push", "@file0", "/sdcard/x", "extra"], 1), /takes an uploaded/);
  assert.throws(() => adbArguments(["push", "@file0", "relative/x"], 1), /must start with/);
});

test("pull takes only a device path and bugreport takes no path", () => {
  assert.throws(() => adbArguments(["pull", "/sdcard/x", "/tmp/local"]), /only a device path/);
  assert.throws(() => adbArguments(["pull", "/data/x"]), /must start with/);
  assert.throws(() => adbArguments(["pull", "/sdcard/../x"]), /cannot contain \.\./);
  assert.throws(() => adbArguments(["bugreport", "/tmp/report.zip"]), /takes no arguments/);
});

test("install accepts only the documented flags and uploaded APKs", () => {
  assert.throws(() => adbArguments(["install", "-s", "@file0"], 1), /not allowed/);
  assert.throws(() => adbArguments(["install", "-x", "@file0"], 1), /install option is not allowed/);
  assert.throws(() => adbArguments(["install", "-r", "app.apk"], 1), /placeholders/);
  assert.throws(() => adbArguments(["install", "-r", "@file0", "@file1"], 2), /exactly one uploaded file/);
  assert.throws(() => adbArguments(["install", "-r", "--abi", "@file0"], 1), /--abi needs an ABI name/);
  assert.throws(() => adbArguments(["install", "-r"], 0), /needs an uploaded file/);
});

test("emu accepts only the documented subset and rejects everything else", () => {
  const allowed = [
    ["emu", "geo", "fix", "-122.084", "37.422"],
    ["emu", "geo", "fix", "-122.084", "37.422", "12"],
    ["emu", "sms", "send", "15551234567", "Your code is 123456"],
    ["emu", "gsm", "call", "15551234567"],
    ["emu", "gsm", "accept", "15551234567"],
    ["emu", "gsm", "cancel", "15551234567"],
    ["emu", "gsm", "busy", "15551234567"],
    ["emu", "gsm", "hold", "15551234567"],
    ["emu", "power", "capacity", "8"],
    ["emu", "power", "status", "charging"],
    ["emu", "power", "status", "not-charging"],
    ["emu", "power", "ac", "on"],
    ["emu", "power", "ac", "off"],
    ["emu", "network", "speed", "gprs"],
    ["emu", "network", "speed", "full"],
    ["emu", "network", "delay", "none"],
    ["emu", "finger", "touch", "0"],
    ["emu", "finger", "remove"],
    ["emu", "rotate"],
  ];
  for (const args of allowed) assert.deepEqual(adbArguments(args), args);

  const rejected = [
    ["emu", "kill"],
    ["emu", "avd", "name"],
    ["emu", "geo", "fix", "181", "0"],
    ["emu", "geo", "fix", "0", "91"],
    ["emu", "geo", "fix", "0"],
    ["emu", "sms", "send", "123"],
    ["emu", "gsm", "dial", "123"],
    ["emu", "power", "capacity", "101"],
    ["emu", "power", "status", "plugged"],
    ["emu", "power", "ac", "maybe"],
    ["emu", "network", "speed", "warp"],
    ["emu", "network", "delay", "instant"],
    ["emu", "finger", "touch", "-1"],
    ["emu", "finger", "remove", "1"],
    ["emu", "rotate", "left"],
  ];
  for (const args of rejected) assert.throws(() => adbArguments(args), /not allowed|must be|between|number/);
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
  assert.equal(adbTimeout(300, ["install", "-r", "@file0"]), 300);
  assert.equal(adbTimeout(300, ["bugreport"]), 300);
  for (const value of [0, -1, 121, 1.5, "30", null]) assert.throws(() => adbTimeout(value), /timeout_s/);
  assert.throws(() => adbTimeout(121, ["shell", "id"]), /timeout_s/);
  assert.throws(() => adbTimeout(301, ["install", "@file0"]), /timeout_s/);
});

test("screenshot and download detection only match their exact calls", () => {
  assert.equal(isScreencap(["exec-out", "screencap", "-p"]), true);
  assert.equal(isScreencap(["shell", "screencap", "-p"]), false);
  assert.equal(isScreencap(["exec-out", "screencap", "-p", "extra"]), false);
  assert.equal(isDownload(["pull", "/sdcard/x"]), true);
  assert.equal(isDownload(["bugreport"]), true);
  assert.equal(isDownload(["exec-out", "cat", "/sdcard/x"]), false);
});

test("adb response parsing rejects malformed runner payloads", () => {
  assert.deepEqual(adbResult({ exit_code: 0, stdout: "ok", stderr: "" }), { exit_code: 0, stdout: "ok", stderr: "" });
  for (const value of [null, {}, { exit_code: "0", stdout: "", stderr: "" }, { exit_code: 0, stdout: 1, stderr: "" }])
    assert.throws(() => adbResult(value));
});
