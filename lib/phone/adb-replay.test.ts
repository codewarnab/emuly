import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAdbReplay } from "../../phone/runner/adb-replay.mjs";

test("a retry key replays only the same adb command, and file bytes are not kept", async () => {
  const replay = createAdbReplay();
  let runs = 0;
  const tap = async () => { runs++; return { exit_code: 0, stdout: `run ${runs}`, stderr: "" }; };
  assert.equal((await replay.run("k1", ["shell", "input", "tap", "1", "1"], tap)).stdout, "run 1");
  const again = await replay.run("k1", ["shell", "input", "tap", "1", "1"], tap);
  assert.deepEqual([again.stdout, again.replayed, runs], ["run 1", true, 1]);
  // The same key with another command runs that command.
  const other = await replay.run("k1", ["shell", "input", "tap", "9", "9"], tap);
  assert.deepEqual([other.stdout, other.replayed, runs], ["run 2", undefined, 2]);
  // A pull's bytes go back to callers of that call only; later the retry runs again.
  const pull = async () => ({ file: Buffer.alloc(1024), filename: "a.bin" });
  const sizeBefore = replay.size;
  assert.equal((await replay.run("k2", ["pull", "/sdcard/a.bin"], pull)).file.length, 1024);
  assert.equal(replay.size, sizeBefore, "no entry holds the file bytes");
});

test("the runner sends keyed /adb calls through the replay cache with the parsed arguments and upload digests", () => {
  const source = readFileSync("phone/runner/runner.mjs", "utf8");
  assert.match(source, /adbReplay\.run\(key, replayArgs,/);
  assert.ok(source.includes("[...request.args, ...await Promise.all(request.paths.map(fileDigest))]"), "the key covers upload bytes");
  assert.doesNotMatch(source, /const adbResults = new Map/);
});
