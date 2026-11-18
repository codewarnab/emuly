// emuly runner: a small HTTP API around adb and the emulator scripts.
// Listens on 127.0.0.1:8790. The dashboard reaches it over `gh codespace ssh -L`.
import ws from "./ws.cjs";
import { openScrcpy } from "./scrcpy.mjs";
import { createHub } from "./scrcpy-hub.mjs";
import { createRecorder } from "./recording.mjs";
import { qualities } from "./scrcpy-protocol.mjs";
import { createApps, CHUNK_SIZE } from "./apps.mjs";
import { startAgentDeviceProxy } from "./agent-device-proxy.mjs";
import { ADB_DOWNLOAD_MAX_BYTES, ADB_FILES_MAX, ADB_OUTPUT_MAX_BYTES, ADB_UPLOAD_MAX_BYTES,
  adbArguments, adbTimeout, isDownload, isScreencap } from "./adb-protocol.mjs";
import { AppError } from "./apk-download.mjs";
import { createLinks } from "./links.mjs";
import { pasteText } from "./paste-text.mjs";
import { RELAY_MAX_PAYLOAD } from "./links-protocol.mjs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Written by the server's setup. The server compares it to skip SSH on a wake.
const SCRIPTS_VERSION = await readFile(join(ROOT, ".scripts-version"), "utf8").then(text => text.trim(), () => "unknown");
const SDK = process.env.SDK_DIR ?? "/opt/android-sdk";
const ADB = join(SDK, "platform-tools", "adb");
const SERIAL = "emulator-5554";
const SECRET = process.env.PHONE_SECRET ?? "";
const PORT = Number(process.env.RUNNER_PORT ?? 8790);
let lifecycle = Promise.resolve();
let boot;
let stopping;
const STOP_ANSWER_MS = 80_000;
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
let adbBusy = false;

/** Run one caller-supplied adb call. A non-zero exit is data, not a transport failure. */
function adbCapture(args, { timeout, binary }) {
  return new Promise((resolve, reject) => {
    execFile(ADB, ["-s", SERIAL, ...args], { timeout, maxBuffer: ADB_OUTPUT_MAX_BYTES, encoding: binary ? "buffer" : "utf8" },
      (error, stdout, stderr) => {
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return reject(new HttpError(413, "adb output was larger than 5 MB. Narrow the command."));
        }
        if (error?.killed) return reject(new HttpError(504, `adb timed out after ${Math.round(timeout / 1000)} s.`));
        if (error?.code === "ENOENT") return reject(new HttpError(503, "adb is not available in this codespace."));
        resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout, stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr });
      });
  });
}

async function booted() {
  try { return (await adb(["shell", "getprop", "sys.boot_completed"], { timeout: 5000 })).trim() === "1"; }
  catch { return false; }
}

function int(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw new HttpError(400, "bad number");
  return String(n);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "invalid JSON"); }
}

function placeholderIndex(value) {
  const match = /^@file(0|[1-9]\d*)$/.exec(value);
  return match ? Number(match[1]) : null;
}

function fileExtension(name, install) {
  if (install) return ".apk";
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(typeof name === "string" ? name : "");
  return match ? `.${match[1]}` : ".bin";
}

function safeFilename(value, fallback) {
  const name = basename(typeof value === "string" ? value : "").replace(/[^\w.-]/g, "_").slice(0, 120);
  return name && name !== "." && name !== ".." ? name : fallback;
}

/** Reads exactly the declared bytes into runner-owned temp files. */
async function streamFiles(req, directory, files, install) {
  let buffered = Buffer.alloc(0);
  let ended = false;
  const iterator = req[Symbol.asyncIterator]();
  async function read(count) {
    while (buffered.length < count && !ended) {
      const next = await iterator.next();
      if (next.done) { ended = true; break; }
      buffered = Buffer.concat([buffered, Buffer.from(next.value)]);
    }
    const part = buffered.subarray(0, count);
    buffered = buffered.subarray(part.length);
    return part;
  }
  const paths = [];
  let total = 0;
  for (let index = 0; index < files.length; index++) {
    const path = join(directory, `file${index}${fileExtension(files[index].name, install)}`);
    const handle = await open(path, "w", 0o600);
    try {
      let remaining = files[index].size;
      while (remaining > 0) {
        const part = await read(Math.min(remaining, 1024 * 1024));
        if (!part.length) throw new HttpError(400, `Upload ended before file${index} was complete.`);
        await handle.write(part);
        remaining -= part.length;
        total += part.length;
        if (total > ADB_UPLOAD_MAX_BYTES) throw new HttpError(413, "Uploads are larger than 200 MB.");
      }
    } finally { await handle.close(); }
    paths.push(path);
  }
  if ((await read(1)).length) throw new HttpError(413, "The upload has bytes that belong to no file.");
  return paths;
}

/** New clients send raw bytes plus a small JSON header. Old JSON-only calls still work. */
async function readAdbRequest(req) {
  const header = req.headers["x-emuly-adb"];
  if (typeof header === "string") {
    if (req.headers["content-type"] !== "application/octet-stream") throw new HttpError(415, "Expected binary file content.");
    let meta;
    try { meta = JSON.parse(header); }
    catch { throw new HttpError(400, "invalid adb file header"); }
    const files = Array.isArray(meta?.files) ? meta.files : [];
    if (files.length > ADB_FILES_MAX) throw new HttpError(400, `Attach at most ${ADB_FILES_MAX} files.`);
    let declared = 0;
    for (const file of files) {
      if (!file || typeof file.name !== "string" || file.name.length > 255
        || !Number.isSafeInteger(file.size) || file.size < 0) throw new HttpError(400, "invalid file part");
      declared += file.size;
      if (declared > ADB_UPLOAD_MAX_BYTES) throw new HttpError(413, "Uploads are larger than 200 MB.");
    }
    const args = adbArguments(meta.args, files.length);
    const seconds = adbTimeout(meta.timeout_s, args);
    const directory = await mkdtemp(join(tmpdir(), "emuly-adb-"));
    try {
      const paths = await streamFiles(req, directory, files, args[0] === "install" || args[0] === "install-multiple");
      return { args, seconds, binary: meta.binary === true, directory, paths };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  const body = await readBody(req, 64 * 1024);
  if (body.files !== undefined) throw new HttpError(400, "Send files as multipart/form-data.");
  const args = adbArguments(body.args);
  return { args, seconds: adbTimeout(body.timeout_s, args), binary: body.binary === true, directory: undefined, paths: [] };
}

/** One file command or ordinary adb call. Temp files are removed in every path. */
async function adbRoute(req) {
  if (adbBusy) throw new HttpError(409, "Another adb command is running. Retry when it finishes.");
  let request;
  let directory;
  adbBusy = true;
  try {
    request = await readAdbRequest(req);
    directory = request.directory;
    if (!directory && isDownload(request.args)) directory = await mkdtemp(join(tmpdir(), "emuly-adb-"));
    if (!(await booted())) throw new HttpError(409, "Android is not ready. Start the phone first.");
    if (request.args[0] === "text") {
      try { await pasteText({ adb, ADB, SERIAL, ROOT, text: request.args[1], timeoutMs: request.seconds * 1000 }); }
      catch (error) { return { exit_code: 1, stdout: "", stderr: String(error?.message ?? error).slice(0, 300) }; }
      return { exit_code: 0, stdout: "", stderr: "" };
    }
    const args = request.args.map(item => {
      const file = placeholderIndex(item);
      return file === null ? item : request.paths[file] ?? item;
    });
    if (isDownload(request.args)) {
      if (!directory) throw new HttpError(500, "temp directory missing");
      const bugreport = request.args[0] === "bugreport";
      const target = bugreport ? join(directory, "bugreport.zip") : join(directory, `pull${fileExtension(args[1], false)}`);
      const command = bugreport ? ["bugreport", target] : ["pull", args[1], target];
      const result = await adbCapture(command, { timeout: request.seconds * 1000 + 2000, binary: false });
      if (result.exitCode !== 0) throw new HttpError(502, result.stderr || `adb ${bugreport ? "bugreport" : "pull"} failed.`);
      let path = target;
      if (bugreport) {
        try { await stat(path); }
        catch {
          const zip = (await readdir(directory)).find(name => name.endsWith(".zip"));
          if (!zip) throw new HttpError(502, "adb did not write a bugreport zip.");
          path = join(directory, zip);
        }
      }
      const info = await stat(path);
      if (info.size > ADB_DOWNLOAD_MAX_BYTES) throw new HttpError(413, "The downloaded file is larger than 100 MB.");
      return { file: await readFile(path), filename: bugreport ? `bugreport-${SERIAL}.zip` : safeFilename(args[1], "device-file"),
        type: "application/octet-stream" };
    }
    const result = await adbCapture(args, { timeout: request.seconds * 1000 + 2000, binary: request.binary || isScreencap(args) });
    if ((request.binary || isScreencap(args)) && result.exitCode !== 0) {
      throw new HttpError(502, result.stderr || "adb screenshot failed.");
    }
    return request.binary || isScreencap(args)
      ? { png: result.stdout }
      : { exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } finally {
    adbBusy = false;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
const apps = await createApps({ root: join(ROOT, "data", "app-installs"), sdk: SDK, run, adb, exclusive, booted });
// The agent-device proxy runs only while this process does; its token never reaches a log.
const agentDevice = startAgentDeviceProxy({ sdk: SDK });
const links = createLinks({ adb, booted });
// A new runner has no links, so any reverse rule on the phone is left from the last runner.
void links.sweep().catch(() => {});

const SCREENSHOT_REUSE_MS = 1_000;
let shot; // { at, png } or { pending }
function screenshot() {
  if (shot?.pending) return shot.pending;
  if (shot && Date.now() - shot.at < SCREENSHOT_REUSE_MS) return Promise.resolve(shot.png);
  const pending = adb(["exec-out", "screencap", "-p"], { binary: true, timeout: 15_000 });
  shot = { pending };
  pending.then(png => { if (shot?.pending === pending) shot = { at: Date.now(), png }; },
    () => { if (shot?.pending === pending) shot = undefined; });
  return pending;
}

const routes = {
  "GET /health": async () => ({ ok: true, version: 14, scripts: SCRIPTS_VERSION, capabilities: ["appsInventory", "apkUpload", "urlInstall", "appLaunch", "clipboard", "adbPassthrough", "adbFiles", "unicodeText", "links", "netCheck", "sharedStream"], avd: "t", api_level: 36, booted: await booted() }),

  "POST /boot": ({ diagnosticOperation }) => {
    return boot ??= exclusive(async () => {
      const start = Date.now();
      // A new emulator makes every open scrcpy session invalid.
      scrcpy.closeAll();
      const operation = typeof diagnosticOperation === "string" && /^[a-f0-9]{32}$/.test(diagnosticOperation) ? diagnosticOperation : undefined;
      await run("bash", [join(ROOT, "scripts", "boot.sh")], { timeout: 600000,
        env: { ...process.env, EMULY_DIAGNOSTICS: operation ? "1" : "0", PH_OPERATION_ID: operation ?? "disabled" } });
      apps.resume();
      // A new emulator has no adb reverse rules. Put back the links of this runner.
      await links.reapply();
      return { booted: await booted(), seconds: Math.round((Date.now() - start) / 1000) };
    }).finally(() => { boot = undefined; });
  },

  // GitHub's port forward ends a request after about 100 s, but stop.sh may wait 120 s for qemu.
  // So answer within 80 s. A later POST /stop joins the same stop and reports its result.
  "POST /stop": async () => {
    stopping ??= (async () => { await apps.stop(); return exclusive(async () => {
      const start = Date.now();
      scrcpy.closeAll();
      for (const client of streams.clients) client.close();
      links.clear();
      await script("stop.sh");
      return { stopped: true, seconds: Math.round((Date.now() - start) / 1000) };
    }); })().finally(() => { setTimeout(() => { stopping = undefined; }, 60_000); });
    let timer;
    const pending = new Promise(resolve => { timer = setTimeout(() => resolve({ stopped: false, pending: true }), STOP_ANSWER_MS); });
    try { return await Promise.race([stopping, pending]); } finally { clearTimeout(timer); }
  },

  "POST /key": async ({ key }) => {
    const keys = { home: "3", back: "4" };
    if (!Object.hasOwn(keys, key)) throw new HttpError(400, "bad key");
    await adb(["shell", "input", "keyevent", keys[key]]);
    return { ok: true };
  },

  // A full-screen PNG costs ~2 s of phone CPU (more during boot). Callers that ask at the same time
  // (previews in several tabs, fallback polls, agents) share one capture, and a result stays
  // valid for SCREENSHOT_REUSE_MS, so Android does the work once.
  "GET /screenshot": async () => ({ png: await screenshot() }),

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
  "GET /agent-device-info": () => agentDevice.info(),

  // Links (docs/link-plan.html). The body of each call is small JSON; see links.mjs.
  "GET /links": () => links.list(),
  "POST /links": body => links.add(body),
  "POST /links/remove": body => links.remove(body),
  "POST /net-check": body => links.netCheck(body),
  "GET /link-hints": async () => ({ logcat: await links.hints() }),

  // Screen recording (recording.mjs): an MP4 made from the shared video stream, with no second encoder.
  "POST /recording/start": body => recorder.start(body),
  "POST /recording/stop": () => recorder.stop(),
  "POST /recording/discard": () => recorder.discard(),
  "GET /recording": () => recorder.status(),

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
    if (req.method === "POST" && path === "/adb") {
      const result = await adbRoute(req);
      if (result?.file) {
        res.writeHead(200, { "content-type": result.type ?? "application/octet-stream",
          "content-disposition": `attachment; filename="${result.filename}"`,
          "content-length": String(result.file.length), "cache-control": "no-store" });
        return res.end(result.file);
      }
      if (result?.png) {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        return res.end(result.png);
      }
      return send(200, result);
    }
    if (req.method === "GET" && path === "/recording/file") {
      const { path: file, bytes, id } = await recorder.file();
      res.writeHead(200, { "content-type": "video/mp4", "content-length": String(bytes), "cache-control": "no-store",
        "content-disposition": `attachment; filename="emuly-recording-${id.slice(0, 8)}.mp4"` });
      return createReadStream(file).on("error", () => res.destroy()).pipe(res);
    }
    // Raw passthrough: streaming bodies, no JSON parsing, no buffering.
    if (path.startsWith("/agent-device/")) return agentDevice.forward(req, res);
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

// One shared scrcpy session per quality (scrcpy-hub.mjs). EMULY_SHARED_STREAM=0 gives each viewer its own.
const scrcpy = createHub({ open: quality => openScrcpy({ adb, ADB, SERIAL, ROOT, quality }),
  share: process.env.EMULY_SHARED_STREAM !== "0" });
const recorder = createRecorder({ attach: (socket, quality) => scrcpy.attach(socket, quality), qualities });
const streams = new ws.WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
const relays = new ws.WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_PAYLOAD, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/links/relay") {
    if (SECRET && req.headers["x-phone-secret"] !== SECRET) return socket.destroy();
    const ports = (url.searchParams.get("ports") ?? "").split(",").filter(Boolean).map(Number);
    return relays.handleUpgrade(req, socket, head, client => links.relay(client, ports));
  }
  if (url.pathname !== "/stream" || (SECRET && req.headers["x-phone-secret"] !== SECRET)) return socket.destroy();
  streams.handleUpgrade(req, socket, head, client => {
    const quality = url.searchParams.get("quality") ?? "auto";
    scrcpy.attach(client, Object.hasOwn(qualities, quality) ? quality : "auto");
  });
});
