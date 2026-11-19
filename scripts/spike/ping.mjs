// Spike only: open a WebSocket and time N {type:"ping"} -> {type:"pong"} round trips.
// Usage: node ping.mjs <wss-url> [n] [ip]
//   ip: optional address to connect to (skips local DNS, which some networks block for *.app.github.dev).
// Env: GITHUB_TOKEN and PHONE_SECRET are sent as headers when set (for a private phone port).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const [url, n = "50", ip] = process.argv.slice(2);
const lookup = ip ? (_host, options, callback) => options?.all ? callback(null, [{ address: ip, family: 4 }]) : callback(null, ip, 4) : undefined;
const headers = {};
if (process.env.GITHUB_TOKEN) headers["X-Github-Token"] = process.env.GITHUB_TOKEN;
if (process.env.PHONE_SECRET) headers["x-phone-secret"] = process.env.PHONE_SECRET;
const t0 = performance.now();
const socket = new WebSocket(url, { headers, perMessageDeflate: false, ...(lookup ? { lookup } : {}) });
const rtts = [];
let firstBinary;
socket.on("open", () => {
  const openMs = performance.now() - t0;
  let sent = 0;
  const tick = () => {
    if (sent++ >= +n) return setTimeout(() => finish(openMs), 500);
    socket.send(JSON.stringify({ type: "ping", time: performance.now() }));
    setTimeout(tick, 200);
  };
  setTimeout(tick, 500);
});
socket.on("message", (data, binary) => {
  if (binary) { firstBinary ??= performance.now() - t0; return; }
  const message = JSON.parse(String(data));
  if (message.type === "pong") rtts.push(performance.now() - message.time);
});
socket.on("error", error => { console.log(JSON.stringify({ url, error: error.message })); process.exit(1); });
function finish(openMs) {
  rtts.sort((a, b) => a - b);
  const q = p => Math.round(rtts[Math.min(rtts.length - 1, Math.floor(p * rtts.length))]);
  console.log(JSON.stringify({ host: new URL(url).host.split(".")[0], open_ms: Math.round(openMs), n: rtts.length,
    min: q(0), median: q(0.5), p95: q(0.95), max: q(1), ...(firstBinary ? { first_video_ms: Math.round(firstBinary) } : {}) }));
  process.exit(0);
}
