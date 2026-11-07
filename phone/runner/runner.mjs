// phonelink runner: a small HTTP API around adb and the emulator scripts.
// Listens on 127.0.0.1:8790. The dashboard reaches it over `gh codespace ssh -L`.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SDK = process.env.SDK_DIR ?? "/opt/android-sdk";
const ADB = join(SDK, "platform-tools", "adb");
const SERIAL = "emulator-5554";
const SECRET = process.env.PHONE_SECRET ?? "";
const PORT = Number(process.env.RUNNER_PORT ?? 8790);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function run(cmd, args, { timeout = 60_000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: binary ? "buffer" : "utf8" },
      (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout));
  });
}
const adb = (args, options) => run(ADB, ["-s", SERIAL, ...args], options);
const script = (name, args = []) => run("bash", [join(ROOT, "scripts", name), ...args], { timeout: 600_000 });

async function booted() {
  try { return (await adb(["shell", "getprop", "sys.boot_completed"], { timeout: 5000 })).trim() === "1"; }
  catch { return false; }
}

function int(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw new HttpError(400, "bad number");
  return String(n);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "invalid JSON"); }
}

async function thirdPartyPackages() {
  const out = await adb(["shell", "pm", "list", "packages", "-3"]);
  return out.split("\n").map(line => line.trim().replace(/^package:/, "")).filter(Boolean);
}

const routes = {
  "GET /health": async () => ({ ok: true, avd: "t", api_level: 36, booted: await booted() }),

  "POST /boot": async ({ mode }) => {
    const start = Date.now();
    await script("boot.sh", [mode === "cold" ? "cold" : "resume"]);
    return { booted: await booted(), seconds: Math.round((Date.now() - start) / 1000) };
  },

  "POST /stop": async () => {
    const start = Date.now();
    await script("stop.sh");
    return { stopped: true, seconds: Math.round((Date.now() - start) / 1000) };
  },

  "GET /screenshot": async () => ({ png: await adb(["exec-out", "screencap", "-p"], { binary: true, timeout: 15_000 }) }),

  "POST /tap": async ({ x, y }) => {
    await adb(["shell", "input", "tap", int(x), int(y)]);
    return { ok: true };
  },

  "POST /swipe": async ({ x1, y1, x2, y2, ms = 300 }) => {
    await adb(["shell", "input", "swipe", int(x1), int(y1), int(x2), int(y2), int(ms)]);
    return { ok: true };
  },

  "POST /text": async ({ text }) => {
    if (typeof text !== "string" || !text || text.length > 500) throw new HttpError(400, "bad text");
    // `input text` runs through the device shell: escape metacharacters, spaces become %s.
    const escaped = text.replace(/[\\'"`$&|;<>()*?!#~{}[\]]/g, c => "\\" + c).replace(/ /g, "%s");
    await adb(["shell", "input", "text", escaped]);
    return { ok: true };
  },

  "POST /install": async ({ url, sha256 }) => {
    if (typeof url !== "string" || !url.startsWith("https://")) throw new HttpError(400, "url must be https");
    const response = await fetch(url);
    if (!response.ok) throw new HttpError(502, `download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256 && createHash("sha256").update(bytes).digest("hex") !== String(sha256).toLowerCase()) {
      throw new HttpError(400, "sha256 mismatch");
    }
    const file = `/tmp/install-${Date.now()}.apk`;
    await writeFile(file, bytes);
    try {
      const before = new Set(await thirdPartyPackages());
      await adb(["install", "-r", file], { timeout: 300_000 });
      const added = (await thirdPartyPackages()).find(name => !before.has(name));
      return { package: added ?? null };
    } finally {
      await rm(file, { force: true });
    }
  },

  "GET /apps": async () => {
    const out = await adb(["shell", "pm", "list", "packages", "-3", "--show-versioncode"]);
    return out.split("\n").map(line => line.trim().match(/^package:(\S+)(?:\s+versionCode:(\S+))?/))
      .filter(Boolean).map(m => ({ package: m[1], version: m[2] ?? null }));
  },
};

createServer(async (req, res) => {
  const send = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  try {
    if (SECRET && req.headers["x-phone-secret"] !== SECRET) return send(401, { error: "unauthorized" });
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const handler = routes[`${req.method} ${path}`];
    if (!handler) return send(404, { error: "not found" });
    const result = await handler(req.method === "POST" ? await readBody(req) : {});
    if (result?.png) {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      return res.end(result.png);
    }
    send(200, result);
  } catch (error) {
    send(error.status ?? 500, { error: error.status ? error.message : String(error.stderr || error.message).slice(-500) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`runner listening on 127.0.0.1:${PORT}`));
