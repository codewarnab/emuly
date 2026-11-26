import { test } from "node:test";
import assert from "node:assert/strict";
import { pullSize, ADB_DOWNLOAD_MAX_BYTES } from "../../phone/runner/adb-protocol.mjs";

test("the runner asks the phone for the size of a pull before it copies anything", async () => {
  const calls: string[][] = [];
  const phone = (kilobytes: string) => async (args: string[]) => { calls.push(args); return kilobytes; };
  // /sdcard/ at 3 GB is refused from du alone; a quote in the path cannot break out of the shell.
  assert.equal(await pullSize("/sdcard/it's", phone("3145728\t/sdcard/it's\n")), 3145728 * 1024);
  assert.deepEqual(calls[0], ["shell", "du", "-skL", "'/sdcard/it'\\''s'"]);
  assert.ok(3145728 * 1024 > ADB_DOWNLOAD_MAX_BYTES);
  // Errors for unreadable folders come first; the total is on the last line.
  assert.equal(await pullSize("/sdcard", phone("du: /sdcard/x: Permission denied\n20\t/sdcard\n")), 20 * 1024);
  // No number, or a failed du, gives no answer, and the size check after the pull still runs.
  assert.equal(await pullSize("/nope", phone("du: /nope: No such file or directory\n")), undefined);
  assert.equal(await pullSize("/nope", async () => { throw new Error("adb failed"); }), undefined);
});
