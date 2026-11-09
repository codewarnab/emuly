// emuly runner: a small HTTP API around adb and the emulator scripts.
// Listens on 127.0.0.1:8790. The dashboard reaches it over `gh codespace ssh -L`.
import ws from "./ws.cjs";
import { startScrcpy } from "./scrcpy.mjs";
import { createApps, CHUNK_SIZE } from "./apps.mjs";
import { AppError } from "./apk-download.mjs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SDK = process.env.SDK_DIR ?? "/opt/android-sdk";
const ADB = join(SDK, "platform-tools", "adb");
const SERIAL = "emulator-5554";
const SECRET = process.env.PHONE_SECRET ?? "";
const PORT = Number(process.env.RUNNER_PORT ?? 8790);
let lifecycle = Promise.resolve();
let boot;
function exclusive(work) {
  const result = lifecycle.then(work);
  lifecycle = result.catch(() => {});
  return result;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function run(cmd, args, { timeout = 60_000, binary = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, env, maxBuffer: 64 * 1024 * 1024, encoding: binary ? "buffer" : "utf8" },
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
const apps = await createApps({ root: join(ROOT, "data", "app-installs"), sdk: SDK, run, adb, exclusive, booted });

const routes = {
  "GET /health": async () => ({ ok: true, version: 7, capabilities: ["appsInventory", "apkUpload", "urlInstall", "appLaunch", "clipboard"], avd: "t", api_level: 36, booted: await booted() }),

  "POST /boot": ({ mode, diagnosticOperation }) => {
    return boot ??= exclusive(async () => {
      const start = Date.now();
      const operation = typeof diagnosticOperation === "string" && /^[a-f0-9]{32}$/.test(diagnosticOperation) ? diagnosticOperation : undefined;
      await run("bash", [join(ROOT, "scripts", "boot.sh"), mode === "cold" ? "cold" : "resume"], { timeout: 600000,
        env: { ...process.env, EMULY_DIAGNOSTICS: operation ? "1" : "0", PH_OPERATION_ID: operation ?? "disabled" } });
      apps.resume();
      return { booted: await booted(), seconds: Math.round((Date.now() - start) / 1000) };
    }).finally(() => { boot = undefined; });
  },

  "POST /stop": async () => { await apps.stop(); return exclusive(async () => {
    const start = Date.now();
    for (const client of streams.clients) client.close();
    await script("stop.sh");
    return { stopped: true, seconds: Math.round((Date.now() - start) / 1000) };
  }); },

  "POST /key": async ({ key }) => {
    const keys = { home: "3", back: "4" };
    if (!Object.hasOwn(keys, key)) throw new HttpError(400, "bad key");
    await adb(["shell", "input", "keyevent", keys[key]]);
    return { ok: true };
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

  "GET /apps": () => apps.inventory(),
  "POST /apps/open": ({ packageId }) => apps.open(packageId),
  "GET /app-installs": () => apps.list(),
  "POST /app-installs": body => apps.create(body),
};

const server = createServer(async (req, res) => {
  const send = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  try {
    if (SECRET && req.headers["x-phone-secret"] !== SECRET) return send(401, { error: "unauthorized" });
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const install = path.match(/^\/app-installs\/([0-9a-f-]{36})(?:\/(content|complete|cancel))?$/);
    if (install) {
      const [, id, action] = install;
      if (req.method === "GET" && !action) return send(200, apps.status(id));
      if (req.method === "POST" && action === "complete") return send(200, await apps.complete(id));
      if (req.method === "POST" && action === "cancel") return send(200, await apps.cancel(id));
      if (req.method === "PUT" && action === "content") {
        if (req.headers["content-type"] !== "application/octet-stream") throw new AppError(415, "invalid_type", "Expected binary APK content.");
        req.setTimeout(30_000, () => req.destroy());
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > CHUNK_SIZE) throw new AppError(413, "too_large", "Upload chunk too large.");
          chunks.push(chunk);
        }
        return send(200, await apps.content(id, Buffer.concat(chunks), Number(req.headers["x-upload-offset"]), req.headers["x-chunk-sha256"]));
      }
      return send(405, { error: "Method not allowed." });
    }
    const handler = routes[`${req.method} ${path}`];
    if (!handler) return send(404, { error: "not found" });
    const result = await handler(req.method === "POST" ? await readBody(req) : {});
    if (result?.png) {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      return res.end(result.png);
    }
    send(200, result);
  } catch (error) {
    send(error.status ?? 500, { error: error.status ? error.message : "Phone operation failed.", errorCode: error.code ?? "runner_error" });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`runner listening on 127.0.0.1:${PORT}`));

const streams = new ws.WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/stream" || (SECRET && req.headers["x-phone-secret"] !== SECRET)) return socket.destroy();
  streams.handleUpgrade(req, socket, head, client => {
    void startScrcpy(client, { adb, ADB, SERIAL, ROOT, quality: url.searchParams.get("quality") ?? "auto" });
  });
});
