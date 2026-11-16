import type { WebSocket } from "ws";
import { RELAY_MAX_PAYLOAD } from "./phone-links-contract.ts";

/** Stop reading one side while the other side has this many bytes waiting. */
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

/**
 * Route B: copy relay frames between the laptop (`emuly link`) and the runner. The bytes are
 * not parsed, so each TCP stream inside stays the business of the two ends.
 * `done` runs once, when either side closes.
 */
export function pipeRelay(laptop: WebSocket, runner: WebSocket, done: () => void) {
  let closed = false;
  const paused = new Set<WebSocket>();
  const close = (code = 1000, reason = "relay closed") => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearInterval(ping);
    for (const socket of [laptop, runner]) { try { socket.close(code, reason); } catch { socket.terminate(); } }
    done();
  };
  const forward = (from: WebSocket, to: WebSocket) => {
    from.on("message", (data, binary) => {
      const size = Array.isArray(data) ? data.reduce((n, part) => n + part.byteLength, 0) : (data as Buffer | ArrayBuffer).byteLength;
      if (!binary || size > RELAY_MAX_PAYLOAD) return close(1003, "relay frames are binary");
      to.send(data as Buffer, { binary: true });
      if (to.bufferedAmount > HIGH_WATER && !paused.has(from)) { from.pause(); paused.add(from); }
    });
    // A runner close code (for example 4404: no relay link) must reach the laptop, so it can say why.
    from.on("close", (code, reason) => close(code >= 4000 && code < 5000 ? code : 1000, reason.toString().slice(0, 120) || "relay closed"));
    from.on("error", () => close(1011, "relay error"));
  };
  forward(laptop, runner);
  forward(runner, laptop);
  const timer = setInterval(() => {
    for (const socket of paused) {
      const other = socket === laptop ? runner : laptop;
      if (other.bufferedAmount < LOW_WATER) { paused.delete(socket); socket.resume(); }
    }
  }, 50);
  // Proxies on the way (GitHub port forwarding, Vercel) close a quiet connection.
  const ping = setInterval(() => { for (const socket of [laptop, runner]) { try { socket.ping(); } catch {} } }, 25_000);
  return close;
}
