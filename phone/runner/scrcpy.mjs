import { spawn } from "node:child_process";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { controlMessage, DeviceMessages, qualities, ScrcpyPackets } from "./scrcpy-protocol.mjs";

// Copy the jar on every connection. Do not cache it per boot "to save time": the scrcpy server
// deletes its own jar when it starts (cleanup=true). A per-boot cache made every viewer after the
// first get no video, with no log line. The push takes about 30 ms on the codespace.
async function pushJar(adb, ROOT) {
  await adb(["push", join(ROOT, "runner/scrcpy-server.jar"), "/data/local/tmp/emuly-scrcpy.jar"]);
}

export async function startScrcpy(ws, { adb, ADB, SERIAL, ROOT, quality }) {
  const scid = randomBytes(4).readUInt32BE() & 0x7fffffff;
  const name = `scrcpy_${scid.toString(16).padStart(8, "0")}`;
  const [size, fps, bitrate] = qualities[quality] ?? qualities.auto;
  let child, video, control, port, closed = false;
  const touches = new Map(), keys = new Set();
  const capabilities = ["clipboard"];
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
  // Step times in ms, so the logs show which step makes the first picture slow. No secrets here.
  const started = Date.now(), steps = {};
  const mark = name => { steps[name] = Date.now() - started; };
  let firstFrame = true;
  try {
    await pushJar(adb, ROOT); mark("jar");
    if (closed) return;
    port = Number((await adb(["forward", "tcp:0", `localabstract:${name}`])).trim());
    if (closed) { void adb(["forward", "--remove", `tcp:${port}`]).catch(() => {}); return; }
    child = spawn(ADB, ["-s", SERIAL, "shell", "CLASSPATH=/data/local/tmp/emuly-scrcpy.jar",
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
    mark("scrcpy");
    video.on("error", close); video.on("close", close);
    control = connect({ host: "127.0.0.1", port });
    control.on("error", close); control.on("close", close);
    // The control socket carries clipboard replies. A single request is answered with 0 or 1 messages.
    const devices = new DeviceMessages();
    control.on("data", chunk => {
      try {
        for (const message of devices.push(chunk)) {
          if (message.type === "clipboard" && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "clipboard", text: message.text.slice(0, 8000) }));
          }
        }
      } catch { close(); }
    });
    const parser = new ScrcpyPackets();
    video.on("data", chunk => {
      try {
        for (const packet of parser.push(chunk)) {
          if (ws.bufferedAmount > 4 * 1024 * 1024) return close();
          ws.send(packet);
          if (firstFrame) { firstFrame = false; mark("first_packet");
            console.log(`[scrcpy] start ${Object.entries(steps).map(([key, value]) => `${key}=${value}`).join(" ")}`); }
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
          ws.send(JSON.stringify({ type: "pong", time: input.time, server: Date.now(), inputAccepted, capabilities }));
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
    // Do not remove this wakeup "to save work". The emulator encoder often sends no frame while
    // the screen is static, so a new viewer saw no picture until a user touched the phone.
    // KEYCODE_WAKEUP (224) makes Android redraw without changing any app or screen state.
    // Do not use home, back, or a touch here; those change what the user sees.
    // Future option, if a stuck static screen still happens: add the scrcpy server option
    // "video_codec_options=repeat-previous-frame-after:100000" to the spawn args above. The encoder then
    // repeats the last frame when nothing changes. It uses more bandwidth all the time, and support
    // in scrcpy 3.3.4 is not confirmed yet, so we do not use it now.
    const wake = setTimeout(() => {
      if (closed || !control?.writable) return;
      try { control.write(controlMessage({ type: "key", key: "wakeup" })); } catch { close(); }
    }, 300);
    wake.unref();
  } catch (error) {
    console.log(`[scrcpy] start_failed error=${String(error?.message ?? error).slice(0, 120).replace(/\s+/g, "_")} ${Object.entries(steps).map(([key, value]) => `${key}=${value}`).join(" ")}`);
    close();
  }
  finally { clearTimeout(timer); }
}
