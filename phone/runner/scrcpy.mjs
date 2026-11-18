import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { AUDIO, AUDIO_BIT_RATE, DeviceMessages, qualities, ScrcpyPackets } from "./scrcpy-protocol.mjs";

// Copy the jar for every scrcpy server start. Do not cache it per boot "to save time": the scrcpy
// server deletes its own jar when it starts (cleanup=true). A per-boot cache made every server after
// the first get no video, with no log line. The push takes about 30 ms on the codespace.
async function pushJar(adb, ROOT) {
  await adb(["push", join(ROOT, "runner/scrcpy-server.jar"), "/data/local/tmp/emuly-scrcpy.jar"]);
}

/**
 * Start one scrcpy server and open its video and control sockets. It knows nothing about viewers:
 * scrcpy-hub.mjs shares one session between viewers.
 * Events: "packet" (browser-framed video packet), "device" (control-socket message), "close" (once).
 * Methods: start() lets video flow; write(bytes) sends a control message; close() stops the server.
 */
export async function openScrcpy({ adb, ADB, SERIAL, ROOT, quality }) {
  const scid = randomBytes(4).readUInt32BE() & 0x7fffffff;
  const name = `scrcpy_${scid.toString(16).padStart(8, "0")}`;
  const [size, fps, bitrate] = qualities[quality] ?? qualities.auto;
  const session = new EventEmitter();
  let child, video, audio, control, port, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (control?.writable) {
      control.end();
      const cleanup = setTimeout(() => control.destroy(), 500); cleanup.unref();
    } else control?.destroy();
    video?.destroy(); audio?.destroy(); child?.kill();
    if (port) void adb(["forward", "--remove", `tcp:${port}`]).catch(() => {});
    session.emit("close");
  };
  session.close = close;
  session.write = bytes => { if (!closed && control?.writable) control.write(bytes); };
  Object.defineProperty(session, "writableLength", { get: () => control?.writableLength ?? 0 });
  // Step times in ms, so the logs show which step makes the first picture slow. No secrets here.
  const started = Date.now(), steps = {};
  const mark = step => { steps[step] = Date.now() - started; };
  const stepText = () => Object.entries(steps).map(([key, value]) => `${key}=${value}`).join(" ");
  try {
    await pushJar(adb, ROOT); mark("jar");
    port = Number((await adb(["forward", "tcp:0", `localabstract:${name}`])).trim());
    child = spawn(ADB, ["-s", SERIAL, "shell", "CLASSPATH=/data/local/tmp/emuly-scrcpy.jar",
      "app_process", "/", "com.genymobile.scrcpy.Server", "3.3.4", `scid=${scid.toString(16)}`,
      "tunnel_forward=true", "audio=true", "audio_codec=opus", `audio_bit_rate=${AUDIO_BIT_RATE}`, "control=true", "video_codec=h264", `max_size=${size}`,
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
    if (closed) throw new Error("scrcpy closed");
    mark("scrcpy");
    video.on("error", close); video.on("close", close);
    // With audio=true scrcpy accepts three sockets in this order: video, audio, control.
    // Audio is optional: a failed audio socket closes only itself, never the video.
    // If Android cannot capture audio, scrcpy sends a 4-byte "disabled" code and no packets.
    audio = connect({ host: "127.0.0.1", port });
    audio.pause();
    audio.on("error", () => audio.destroy());
    const audioParser = new ScrcpyPackets();
    audio.on("data", chunk => {
      try { for (const packet of audioParser.push(chunk)) { packet[0] |= AUDIO; if (!closed) session.emit("packet", packet); } }
      catch { audio.destroy(); }
    });
    control = connect({ host: "127.0.0.1", port });
    control.on("error", close); control.on("close", close);
    const devices = new DeviceMessages();
    control.on("data", chunk => {
      try { for (const message of devices.push(chunk)) session.emit("device", message); } catch { close(); }
    });
    const parser = new ScrcpyPackets();
    let firstPacket = true;
    video.on("data", chunk => {
      try {
        for (const packet of parser.push(chunk)) {
          if (closed) return;
          session.emit("packet", packet);
          if (firstPacket) { firstPacket = false; mark("first_packet"); console.log(`[scrcpy] start quality=${quality} ${stepText()}`); }
        }
      } catch { close(); }
    });
    // The caller calls start() after it adds its listeners. A resume here could emit the config
    // packet before anyone listens, and a decoder cannot start without it.
    session.start = () => { if (!closed) { video.resume(); audio.resume(); } };
    return session;
  } catch (error) {
    console.log(`[scrcpy] start_failed error=${String(error?.message ?? error).slice(0, 120).replace(/\s+/g, "_")} ${stepText()}`);
    close();
    throw error;
  }
}
