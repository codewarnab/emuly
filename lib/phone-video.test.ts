import { test } from "node:test";
import assert from "node:assert/strict";
import { issueStreamTicket, takeStreamTicket } from "./phone-stream-ticket.ts";
import { avcCodec, screenPoint, videoPacket } from "./phone-video.ts";
import { controlMessage, ScrcpyPackets } from "../phone/runner/scrcpy-protocol.mjs";

const binding = { userId: 7, phoneId: "phone-a", origin: "http://localhost:4321", cookie: "session=synthetic",
  open: async () => { throw new Error("not used"); } };
test("stream tickets expire at 60 seconds, bind browser and phone, and cannot be replayed", () => {
  const ticket = issueStreamTicket(binding, 100);
  assert.equal(takeStreamTicket(ticket, "phone-b", binding.origin, binding.cookie, 101), undefined);
  assert.equal(takeStreamTicket(ticket, binding.phoneId, "https://evil.invalid", binding.cookie, 101), undefined);
  assert.equal(takeStreamTicket(ticket, binding.phoneId, binding.origin, "session=other", 101), undefined);
  assert.equal(takeStreamTicket(ticket, binding.phoneId, binding.origin, binding.cookie, 60_099)?.userId, 7);
  assert.equal(takeStreamTicket(ticket, binding.phoneId, binding.origin, binding.cookie, 60_099), undefined);
  const expired = issueStreamTicket(binding, 100);
  assert.equal(takeStreamTicket(expired, binding.phoneId, binding.origin, binding.cookie, 60_100), undefined);
});
test("split and coalesced scrcpy packets preserve config, keyframe, PTS, and payload", () => {
  const config = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0x80, 0x1f, 0, 0, 1, 0x68]);
  function packet(flags: bigint, data: Buffer) {
    const b = Buffer.alloc(12); b.writeBigUInt64BE(flags); b.writeUInt32BE(data.length, 8); return Buffer.concat([b, data]);
  }
  const stream = Buffer.concat([packet(BigInt(1) << BigInt(63), config), packet((BigInt(1) << BigInt(62)) | BigInt(12345), Buffer.from([0x65, 1, 2]))]);
  const parser = new ScrcpyPackets();
  assert.deepEqual(parser.push(stream.subarray(0, 7)), []);
  const result = parser.push(stream.subarray(7)).map(b => videoPacket(Uint8Array.from(b).buffer));
  assert.equal(result.length, 2); assert.equal(result[0].config, true);
  assert.equal(avcCodec(result[0].data), "avc1.42801f");
  assert.equal(result[1].key, true); assert.equal(result[1].pts, 12345);
  assert.deepEqual([...result[1].data], [0x65, 1, 2]);
  const bad = Buffer.alloc(12); bad.writeUInt32BE(9 * 1024 * 1024, 8);
  assert.throws(() => new ScrcpyPackets().push(bad), /Invalid video/);
  assert.throws(() => videoPacket(new ArrayBuffer(17)), /Invalid video/);
  assert.throws(() => avcCodec(new Uint8Array([1, 2, 3])), /configuration/);
});
test("scrcpy controls match independent big-endian wire fixtures and reject unsafe inputs", () => {
  assert.equal(controlMessage({ type: "key", key: "home" }).toString("hex"), "00000000000300000000000000000001000000030000000000000000");
  const touch = controlMessage({ type: "touch", action: "down", pointer: 1, x: 10, y: 20, width: 720, height: 1280 });
  assert.equal(touch.toString("hex"), "020000000000000000010000000a0000001402d00500ffff0000000000000000");
  assert.equal(controlMessage({ type: "touch", action: "up", pointer: 1, x: 10, y: 20, width: 720, height: 1280 }).readUInt16BE(22), 0);
  assert.equal(controlMessage({ type: "paste", text: "你好" }).toString("hex"), "0900000000000000000100000006e4bda0e5a5bd");
  assert.equal(controlMessage({ type: "rotate" }).toString("hex"), "0b");
  assert.equal(controlMessage({ type: "keyframe" }).toString("hex"), "11");
  assert.equal(controlMessage({ type: "wheel", x: 1, y: 2, width: 720, height: 1280, dx: 0, dy: -16 }).readInt16BE(15), -32767);
  for (const input of [ { type: "key", key: "__proto__" }, { type: "text", text: "a".repeat(301) },
    { type: "touch", action: "down", pointer: -1, x: 0, y: 0, width: 720, height: 1280 },
    { type: "wheel", x: 720, y: 0, width: 720, height: 1280, dx: 0, dy: 0 } ]) assert.throws(() => controlMessage(input));
});
test("screen coordinates use the displayed image bounds and clamp captured drags", () => {
  const rect = { left: 10, top: 20, width: 180, height: 320 };
  assert.deepEqual(screenPoint(100, 180, rect, 720, 1280), { x: 360, y: 640, width: 720, height: 1280 });
  assert.deepEqual(screenPoint(-1, 900, rect, 720, 1280), { x: 0, y: 1279, width: 720, height: 1280 });
});
