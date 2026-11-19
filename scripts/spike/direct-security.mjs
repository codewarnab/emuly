// Phase 3 live security test against a public port 8791.
// Usage: node --conditions=react-server --experimental-strip-types scripts/spike/direct-security.mjs <codespace> <secret> [ip]
import { createRequire } from "node:module";
import { issueDirectTicket } from "../../lib/phone/direct-ticket.ts";
const require = createRequire(import.meta.url);
const WebSocket = require("next/dist/compiled/ws");
const [codespace, secret, ip] = process.argv.slice(2);
const host = `${codespace}-8791.app.github.dev`;
const ORIGIN = "https://emuly.vercel.app";
const lookup = ip ? (_h, o, cb) => o?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4) : undefined;
const base = { codespaceName: codespace, phoneId: "ph_test", userId: 1, sessionId: "s", quality: "auto", origin: ORIGIN };
const t = (over = {}, opts = {}) => encodeURIComponent(issueDirectTicket({ ...base, ...over }, { secret, ...opts }));
function open(path, origin = ORIGIN) {
  return new Promise(resolve => {
    const s = new WebSocket(`wss://${host}${path}`, { origin, ...(lookup ? { lookup } : {}) });
    const done = r => { resolve(r); s.terminate(); };
    s.once("message", d => done(`OPEN (${String(d)})`));
    s.once("unexpected-response", (_q, res) => done(`HTTP ${res.statusCode}`));
    s.once("error", e => done(`error ${e.message}`));
    setTimeout(() => done("timeout"), 10000);
  });
}
async function http(path, headers = {}) {
  const { request } = await import("node:https");
  return new Promise(resolve => request({ host, path, headers, ...(lookup ? { lookup } : {}) }, r => { r.resume(); resolve(`HTTP ${r.statusCode}`); })
    .on("error", e => resolve(`error ${e.message}`)).end());
}
const replay = t();
const cases = [
  ["valid ticket", () => open(`/stream?ticket=${t()}`), /^OPEN/],
  ["no ticket", () => open("/stream"), /^HTTP 404/],
  ["old ticket (31 s)", () => open(`/stream?ticket=${t({}, { now: Date.now() - 31_000 })}`), /^HTTP 404/],
  ["ticket for another phone", () => open(`/stream?ticket=${t({ codespaceName: "phone-other-xyz" })}`), /^HTTP 404/],
  ["ticket signed with another secret", () => open(`/stream?ticket=${t({}, { secret: "x".repeat(48) })}`), /^HTTP 404/],
  ["replay: first use", () => open(`/stream?ticket=${replay}`), /^OPEN/],
  ["replay: second use", () => open(`/stream?ticket=${replay}`), /^HTTP 404/],
  ["wrong Origin", () => open(`/stream?ticket=${t()}`, "https://evil.example"), /^HTTP 404/],
  ["ws /adb with valid ticket", () => open(`/adb?ticket=${t()}`), /^HTTP 404/],
  ["ws /links/relay", () => open(`/links/relay?ticket=${t()}`), /^HTTP 404/],
  ["GET /health", () => http("/health"), /^HTTP 404/],
  ["GET /screenshot", () => http("/screenshot"), /^HTTP 404/],
];
let failed = 0;
for (const [name, run, want] of cases) {
  const got = await run();
  const ok = want.test(got);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(36)} ${got}`);
}
let limited = 0;
for (let i = 0; i < 25; i++) if ((await open("/stream?ticket=bad")) === "HTTP 429") limited++;
console.log(`${limited > 0 ? "PASS" : "FAIL"}  rate limit (25 bad tries)`.padEnd(42) + ` ${limited} answered 429`);
if (!limited) failed++;
process.exit(failed ? 1 : 0);
