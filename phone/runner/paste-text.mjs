import { spawn } from "node:child_process";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// Type any Unicode text into the focused field. `adb shell input text` sends one key press per
// character and supports ASCII only, so it cannot type "café" or "नमस्ते". This starts a short
// scrcpy session with no video and no audio, sends SET_CLIPBOARD with paste=true, and waits for
// the clipboard ack. Android then pastes the text into the focused field.
// The text replaces the phone's clipboard. Nothing reaches a shell, so no escaping is needed.

/** The jar has its own path: the server deletes its jar on start (cleanup=true), and a shared
 *  path could delete the jar while a video session starts. */
const JAR = "/data/local/tmp/emuly-scrcpy-text.jar";
const SET_CLIPBOARD = 9;
const ACK_CLIPBOARD = 1;
export const PASTE_TEXT_MAX_BYTES = 8192;

/** SET_CLIPBOARD: type u8, sequence u64, paste u8, length u32, UTF-8 text. */
export function setClipboardMessage(text, sequence) {
  const bytes = Buffer.from(text, "utf8");
  const message = Buffer.alloc(14 + bytes.length);
  message[0] = SET_CLIPBOARD;
  message.writeBigUInt64BE(BigInt(sequence), 1);
  message[9] = 1;
  message.writeUInt32BE(bytes.length, 10);
  bytes.copy(message, 14);
  return message;
}

/** Throws a message for the caller when the text cannot be sent. */
export function checkPasteText(text) {
  if (typeof text !== "string" || !text) throw new Error("Send non-empty text.");
  if (Buffer.byteLength(text, "utf8") > PASTE_TEXT_MAX_BYTES) throw new Error(`Text must be at most ${PASTE_TEXT_MAX_BYTES} UTF-8 bytes.`);
  if (text.includes("\0")) throw new Error("Text cannot contain a NUL character.");
}

/**
 * Finds an ACK_CLIPBOARD with `sequence` in the device bytes read so far. Other device messages
 * (a clipboard text, type 0, or UHID output, type 2) are skipped.
 * Returns "ack", "more" (wait for more bytes) or "bad".
 */
export function readAck(buffer, sequence) {
  let offset = 0;
  while (offset < buffer.length) {
    const type = buffer[offset];
    if (type === ACK_CLIPBOARD) {
      if (buffer.length < offset + 9) return "more";
      if (buffer.readBigUInt64BE(offset + 1) === BigInt(sequence)) return "ack";
      offset += 9;
    } else if (type === 0) {
      if (buffer.length < offset + 5) return "more";
      offset += 5 + buffer.readUInt32BE(offset + 1);
    } else if (type === 2) {
      if (buffer.length < offset + 5) return "more";
      offset += 5 + buffer.readUInt16BE(offset + 3);
    } else return "bad";
  }
  return "more";
}

/** Pastes `text` into the focused field. Resolves after the device confirms the clipboard. */
export async function pasteText({ adb, ADB, SERIAL, ROOT, text, timeoutMs = 15_000 }) {
  checkPasteText(text);
  const scid = randomBytes(4).readUInt32BE() & 0x7fffffff;
  const name = `scrcpy_${scid.toString(16).padStart(8, "0")}`;
  const sequence = 1 + (randomBytes(4).readUInt32BE() & 0x7fffffff);
  let child, socket, port;
  const deadline = Date.now() + timeoutMs;
  try {
    await adb(["push", join(ROOT, "runner/scrcpy-server.jar"), JAR]);
    port = Number((await adb(["forward", "tcp:0", `localabstract:${name}`])).trim());
    if (!Number.isInteger(port) || port <= 0) throw new Error("adb forward failed");
    let exited = false;
    child = spawn(ADB, ["-s", SERIAL, "shell", `CLASSPATH=${JAR}`,
      "app_process", "/", "com.genymobile.scrcpy.Server", "3.3.4", `scid=${scid.toString(16)}`,
      "tunnel_forward=true", "video=false", "audio=false", "control=true", "send_dummy_byte=true",
      "send_device_meta=false", "clipboard_autosync=false", "cleanup=true"], { stdio: "ignore" });
    child.on("error", () => { exited = true; });
    child.on("exit", () => { exited = true; });
    // adb forward may accept TCP before the device socket exists. Retry until the dummy byte arrives.
    let first;
    for (;;) {
      if (exited) throw new Error("scrcpy server exited");
      try {
        [socket, first] = await new Promise((resolve, reject) => {
          const candidate = connect({ host: "127.0.0.1", port });
          candidate.setTimeout(1000, () => candidate.destroy(new Error("not ready")));
          candidate.once("error", reject);
          candidate.once("close", () => reject(new Error("not ready")));
          candidate.once("data", chunk => {
            candidate.setTimeout(0);
            candidate.removeAllListeners("error"); candidate.removeAllListeners("close");
            if (chunk[0] !== 0) { candidate.destroy(); return reject(new Error("Invalid scrcpy handshake")); }
            resolve([candidate, chunk.subarray(1)]);
          });
        });
        break;
      } catch (error) {
        if (error?.message === "Invalid scrcpy handshake" || Date.now() >= deadline) throw new Error("scrcpy did not start");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await new Promise((resolve, reject) => {
      let buffer = first;
      const timer = setTimeout(() => reject(new Error("The phone did not confirm the text.")), Math.max(1000, deadline - Date.now()));
      const done = error => { clearTimeout(timer); socket.removeAllListeners("data"); error ? reject(error) : resolve(); };
      const check = () => {
        const state = readAck(buffer, sequence);
        if (state === "ack") done();
        else if (state === "bad") done(new Error("Invalid scrcpy reply"));
        else if (buffer.length > 1024 * 1024) done(new Error("Invalid scrcpy reply"));
      };
      socket.on("data", chunk => { buffer = Buffer.concat([buffer, chunk]); check(); });
      socket.once("error", done);
      socket.once("close", () => done(new Error("scrcpy closed before it confirmed the text")));
      socket.write(setClipboardMessage(text, sequence));
      check();
    });
    // The ack comes after the clipboard is set. Give Android a moment to inject the paste key
    // before the server stops.
    await new Promise(resolve => setTimeout(resolve, 150));
  } finally {
    socket?.destroy();
    child?.kill();
    if (port) await adb(["forward", "--remove", `tcp:${port}`]).catch(() => {});
  }
}
