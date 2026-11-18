import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPasteText, readAck, setClipboardMessage, PASTE_TEXT_MAX_BYTES } from "../../phone/runner/paste-text.mjs";

test("SET_CLIPBOARD carries the sequence, the paste flag and the UTF-8 text", () => {
  const message: Buffer = setClipboardMessage("नमस्ते", 7);
  const text = Buffer.from("नमस्ते", "utf8");
  assert.equal(message[0], 9);
  assert.equal(message.readBigUInt64BE(1), BigInt(7));
  assert.equal(message[9], 1);
  assert.equal(message.readUInt32BE(10), text.length);
  assert.deepEqual(message.subarray(14), text);
});

test("paste text must be non-empty, without NUL, and within the byte limit", () => {
  assert.doesNotThrow(() => checkPasteText("café 👋"));
  assert.throws(() => checkPasteText(""), /non-empty/);
  assert.throws(() => checkPasteText(42), /non-empty/);
  assert.throws(() => checkPasteText("a\0b"), /NUL/);
  assert.throws(() => checkPasteText("ा".repeat(PASTE_TEXT_MAX_BYTES)), /UTF-8 bytes/);
});

test("the ack reader waits for the matching sequence and skips other device messages", () => {
  const ack = (sequence: number) => { const b = Buffer.alloc(9); b[0] = 1; b.writeBigUInt64BE(BigInt(sequence), 1); return b; };
  const clipboard = Buffer.concat([Buffer.from([0, 0, 0, 0, 2]), Buffer.from("hi")]);
  assert.equal(readAck(Buffer.alloc(0), 5), "more");
  assert.equal(readAck(ack(5).subarray(0, 4), 5), "more");
  assert.equal(readAck(ack(4), 5), "more");
  assert.equal(readAck(Buffer.concat([clipboard, ack(4), ack(5)]), 5), "ack");
  assert.equal(readAck(Buffer.from([9]), 5), "bad");
});
