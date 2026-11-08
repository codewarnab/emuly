import { spawn } from "node:child_process";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { controlMessage, qualities, ScrcpyPackets } from "./scrcpy-protocol.mjs";

export async function startScrcpy(ws, { adb, ADB, SERIAL, ROOT, quality }) {
  const scid = randomBytes(4).readUInt32BE() & 0x7fffffff;
  const name = `scrcpy_${scid.toString(16).padStart(8, "0")}`;
  const [size, fps, bitrate] = qualities[quality] ?? qualities.auto;
  let child, video, control, port, closed = false;
  const touches = new Map(), keys = new Set();
  const close = () => {
    if (closed) return;
    closed = true;
    if (control?.writable) {
      for (const input of touches.values()) control.write(controlMessage({ ...input, action: "cancel" }));
      for (const key of keys) control.write(controlMessage({ type: "key", key, action: "up" }));
      control.end();
      const cleanup = setTimeout(() => control.destroy(), 500); cleanup.unref();
    }
    video?.destroy(); child?.kill(); ws.close();
    if (port) void adb(["forward", "--remove", `tcp:${port}`]).catch(() => {});
  };
  ws.on("close", close); ws.on("error", close);
  const timer = setTimeout(close, 20_000);
  try {
    await adb(["push", join(ROOT, "runner/scrcpy-server.jar"), "/data/local/tmp/phonelink-scrcpy.jar"]);
    if (closed) return;
    port = Number((await adb(["forward", "tcp:0", `localabstract:${name}`])).trim());
    if (closed) { void adb(["forward", "--remove", `tcp:${port}`]).catch(() => {}); return; }
    child = spawn(ADB, ["-s", SERIAL, "shell", "CLASSPATH=/data/local/tmp/phonelink-scrcpy.jar",
      "app_process", "/", "com.genymobile.scrcpy.Server", "3.3.4", `scid=${scid.toString(16)}`,
      "tunnel_forward=true", "audio=false", "control=true", "video_codec=h264", `max_size=${size}`,
      `max_fps=${fps}`, `video_bit_rate=${bitrate}`, "send_dummy_byte=true", "send_device_meta=false", "send_codec_meta=false",
      "clipboard_autosync=false", "cleanup=true"], { stdio: "ignore" });
    child.on("error", close); child.on("exit", close);
    // adb forward may accept TCP before the device's local socket exists. Retry until its dummy byte arrives.
    const deadline = Date.now() + 15_000;
    while (!closed) {
      try {
        video = await new Promise((resolve, reject) => {
          const socket = connect({ host: "127.0.0.1", port });
          socket.setTimeout(1000, () => socket.destroy(new Error("scrcpy not ready")));
          socket.once("error", reject);
          socket.once("data", chunk => { socket.pause(); socket.setTimeout(0); socket.removeListener("error", reject);
            if (chunk[0] !== 0) { socket.destroy(); return reject(new Error("Invalid scrcpy handshake")); }
            if (chunk.length > 1) socket.unshift(chunk.subarray(1));
            resolve(socket);
          });
          socket.once("close", () => reject(new Error("scrcpy not ready")));
        });
        break;
      } catch { if (closed || Date.now() >= deadline) throw new Error("scrcpy timeout"); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (closed) { video?.destroy(); return; }
    video.on("error", close); video.on("close", close);
    control = connect({ host: "127.0.0.1", port });
    control.on("error", close); control.on("close", close); control.resume();
    const parser = new ScrcpyPackets();
    video.on("data", chunk => {
      try {
        for (const packet of parser.push(chunk)) {
          if (ws.bufferedAmount > 4 * 1024 * 1024) return close();
          ws.send(packet);
        }
      } catch { close(); }
    });
    let count = 0, window = Date.now();
    let inputAccepted = false;
    ws.on("message", (data, binary) => {
      try {
        if (Date.now() - window >= 1000) { count = 0; window = Date.now(); }
        if (binary || data.length > 16_384 || ++count > 240 || control.writableLength > 65_536) return close();
        const input = JSON.parse(data.toString());
        if (input.type === "ping" && Number.isFinite(input.time)) {
          ws.send(JSON.stringify({ type: "pong", time: input.time, server: Date.now(), inputAccepted }));
          inputAccepted = false;
          return;
        }
        const bytes = controlMessage(input);
        inputAccepted = true;
        if (input.type === "touch") {
          if (["up", "cancel"].includes(input.action)) touches.delete(input.pointer);
          else touches.set(input.pointer, input);
        }
        if (input.type === "key" && input.action) {
          if (input.action === "up") keys.delete(input.key); else keys.add(input.key);
        }
        control.write(bytes);
      } catch { close(); }
    });
    clearTimeout(timer);
    video.resume();
  } catch { close(); }
  finally { clearTimeout(timer); }
}
