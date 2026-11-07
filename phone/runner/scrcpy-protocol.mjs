// scrcpy 3.3.4 protocol. All integers are big endian.
export const qualities = { auto: [1080, 30, 4_000_000], sharp: [1080, 30, 8_000_000], saver: [720, 15, 1_500_000] };
const keys = {
  ...Object.fromEntries(Array.from({ length: 26 }, (_, i) => ["Key" + String.fromCharCode(65 + i), 29 + i])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => ["Digit" + i, 7 + i])), home: 3, back: 4, recent: 187, volumeUp: 24, volumeDown: 25,
  Enter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: 4,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, PageUp: 92, PageDown: 93,
  Home: 122, End: 123 };
export function controlMessage(input) {
  const integer = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
  if (!input || typeof input !== "object") throw new Error("Invalid input");
  const { type } = input;
  if (type === "rotate" || type === "keyframe") return Buffer.from([type === "rotate" ? 11 : 17]);
  if (type === "text" || type === "paste") {
    if (typeof input.text !== "string" || !input.text || Buffer.byteLength(input.text) > (type === "text" ? 300 : 8192)) throw new Error("Invalid text");
    const text = Buffer.from(input.text);
    const b = Buffer.alloc((type === "paste" ? 14 : 5) + text.length);
    b[0] = type === "paste" ? 9 : 1;
    if (type === "paste") b[9] = 1;
    b.writeUInt32BE(text.length, type === "paste" ? 10 : 1);
    text.copy(b, type === "paste" ? 14 : 5);
    return b;
  }
  if (type === "key") {
    if (!Object.hasOwn(keys, input.key) || !["down", "up", undefined].includes(input.action)) throw new Error("Invalid key");
    const meta = input.meta ?? 0;
    if (!integer(meta, 0x11003) || (meta & ~0x11003)) throw new Error("Invalid modifiers");
    const key = action => { const b = Buffer.alloc(14); b[1] = action; b.writeUInt32BE(keys[input.key], 2); b.writeUInt32BE(meta, 10); return b; };
    return input.action ? key(input.action === "down" ? 0 : 1) : Buffer.concat([key(0), key(1)]);
  }
  if (!["touch", "wheel"].includes(type) || !integer(input.width, 65535) || !integer(input.height, 65535) ||
      !input.width || !input.height || !integer(input.x, input.width - 1) || !integer(input.y, input.height - 1)) throw new Error("Invalid position");
  const b = Buffer.alloc(type === "touch" ? 32 : 21);
  b[0] = type === "touch" ? 2 : 3;
  const offset = type === "touch" ? 10 : 1;
  b.writeUInt32BE(input.x, offset); b.writeUInt32BE(input.y, offset + 4);
  b.writeUInt16BE(input.width, offset + 8); b.writeUInt16BE(input.height, offset + 10);
  if (type === "touch") {
    if (!["down", "up", "move", "cancel"].includes(input.action) || !integer(input.pointer, 31)) throw new Error("Invalid touch");
    b[1] = { down: 0, up: 1, move: 2, cancel: 3 }[input.action];
    b.writeBigUInt64BE(BigInt(input.pointer), 2);
    b.writeUInt16BE(["up", "cancel"].includes(input.action) ? 0 : 65535, 22);
  } else {
    if (![input.dx, input.dy].every(n => Number.isFinite(n) && Math.abs(n) <= 16)) throw new Error("Invalid wheel");
    b.writeInt16BE(Math.round(input.dx / 16 * 32767), 13); b.writeInt16BE(Math.round(input.dy / 16 * 32767), 15);
  }
  return b;
}

// Handles split/coalesced TCP chunks. scrcpy sends 12-byte packet headers.
export class ScrcpyPackets {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const packets = [];
    while (this.buffer.length >= 12) {
      const size = this.buffer.readUInt32BE(8);
      if (!size || size > 8 * 1024 * 1024) throw new Error("Invalid video packet");
      if (this.buffer.length < size + 12) break;
      const flags = this.buffer.readBigUInt64BE();
      // Browser header: flags u8 (config=2,key=1), pts u64, runner send time f64 milliseconds.
      const header = Buffer.alloc(17);
      header[0] = Number(flags >> 62n & 3n);
      header.writeBigUInt64BE(flags & 0x3fffffffffffffffn, 1);
      header.writeDoubleBE(Date.now(), 9);
      packets.push(Buffer.concat([header, this.buffer.subarray(12, 12 + size)]));
      this.buffer = this.buffer.subarray(12 + size);
    }
    return packets;
  }
}
