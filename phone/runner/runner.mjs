// emuly runner: a small HTTP API around adb and the emulator scripts.
// Listens on 127.0.0.1:8790. The dashboard reaches it over `gh codespace ssh -L`.
import ws from "./ws.cjs";
import { openScrcpy } from "./scrcpy.mjs";
import { createHub } from "./scrcpy-hub.mjs";
import { createRecorder } from "./recording.mjs";
import { gridOptions, makeGrid, scalePng, screenshotScale } from "./grid.mjs";
import { createUiReader } from "./ui-tree.mjs";
import { createEvents } from "./events.mjs";
import { liveQualities, qualities } from "./scrcpy-protocol.mjs";
import { createApps, CHUNK_SIZE } from "./apps.mjs";
import { startAgentDeviceProxy } from "./agent-device-proxy.mjs";
import { pullSize, ADB_DOWNLOAD_MAX_BYTES, ADB_FILES_MAX, ADB_OUTPUT_MAX_BYTES, ADB_UPLOAD_MAX_BYTES,
  adbArguments, adbTimeout, isDownload, isScreencap } from "./adb-protocol.mjs";
import { AppError } from "./apk-download.mjs";
import { createAdbReplay } from "./adb-replay.mjs";
import { createFileFetches } from "./file-fetch.mjs";
import { createLinks } from "./links.mjs";
import { createEgress } from "./egress.mjs";
import { pasteText } from "./paste-text.mjs";
import { createDirectServer } from "./direct-server.mjs";
import { createRunnerKey } from "./runner-key.mjs";
import { RELAY_MAX_PAYLOAD } from "./links-protocol.mjs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
// Second lock on this port, after GitHub port privacy. See runner-key.mjs for its exact limits.
const runnerKey = createRunnerKey({ file: join(ROOT, ".runner-key") });
await runnerKey.load();
const PORT = Number(process.env.RUNNER_PORT ?? 8790);
let lifecycle = Promise.resolve();
let boot;
let stopping;
/** True once the cached stop has finished. A boot then clears it, so the next stop runs again. */
let stopSettled = false;
const STOP_ANSWER_MS = 80_000;
// Busy work for GET /health: the server updates a running runner only when nothing uses it.
let lifecycleWork = 0;
let requestsInFlight = 0;
let lastRequestAt = Date.now();
function exclusive(work) {
  lifecycleWork++;
  const result = lifecycle.then(work).finally(() => { lifecycleWork--; });
  lifecycle = result.catch(() => {});
  return result;
}

class HttpError extends Error {
  /** ran (adb errors only): false = adb did not start, true = it ran, "unknown" = it may have run. */
  constructor(status, message, ran) { super(message); this.status = status; if (ran !== undefined) this.ran = ran; }
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
          return reject(new HttpError(413, "adb output was larger than 5 MB. Narrow the command.", true));
        }
        if (error?.killed) return reject(new HttpError(504, `adb timed out after ${Math.round(timeout / 1000)} s. The command may have run.`, "unknown"));
        if (error?.code === "ENOENT") return reject(new HttpError(503, "adb is not available in this codespace.", false));
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
    const hash = typeof files[index].sha256 === "string" ? createHash("sha256") : undefined;
    try {
      let remaining = files[index].size;
      while (remaining > 0) {
        const part = await read(Math.min(remaining, 1024 * 1024));
        if (!part.length) throw new HttpError(400, `Upload ended before file${index} was complete.`);
        await handle.write(part);
        hash?.update(part);
        remaining -= part.length;
        total += part.length;
        if (total > ADB_UPLOAD_MAX_BYTES) throw new HttpError(413, "Uploads are larger than 1 GiB.");
      }
    } finally { await handle.close(); }
    if (hash && hash.digest("hex") !== files[index].sha256) throw new HttpError(400, `file${index} does not match its SHA-256 in the ticket.`);
    paths.push(path);
  }
  if ((await read(1)).length) throw new HttpError(413, "The upload has bytes that belong to no file.");
  return paths;
}

/**
 * New clients send raw bytes plus a small JSON header. Old JSON-only calls still work.
 * A direct upload (port 8791) passes `ticket`: the signed ticket gives args and files, and the header is ignored.
 */
async function readAdbRequest(req, ticket) {
  const header = ticket ? undefined : req.headers["x-emuly-adb"];
  if (ticket || typeof header === "string") {
    if (req.headers["content-type"] !== "application/octet-stream") throw new HttpError(415, "Expected binary file content.");
    let meta = ticket;
    if (!meta) {
      try { meta = JSON.parse(header); }
      catch { throw new HttpError(400, "invalid adb file header"); }
    }
    const files = Array.isArray(meta?.files) ? meta.files : [];
    if (files.length > ADB_FILES_MAX) throw new HttpError(400, `Attach at most ${ADB_FILES_MAX} files.`);
    let declared = 0;
    for (const file of files) {
      if (!file || typeof file.name !== "string" || file.name.length > 255
        || !Number.isSafeInteger(file.size) || file.size < 0) throw new HttpError(400, "invalid file part");
      declared += file.size;
      if (declared > ADB_UPLOAD_MAX_BYTES) throw new HttpError(413, "Uploads are larger than 1 GiB.");
    }
    const args = adbArguments(meta.args, files.length);
    if (ticket && !["install", "install-multiple", "push"].includes(args[0])) throw new HttpError(400, "A direct upload runs only install, install-multiple or push.");
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
async function adbRoute(req, ticket, key) {
  if (adbBusy) throw new HttpError(409, "Another adb command is running. Retry when it finishes.", false);
  let directory;
  adbBusy = true;
  try {
    const request = await readAdbRequest(req, ticket);
    directory = request.directory;
    if (!directory && isDownload(request.args)) directory = await mkdtemp(join(tmpdir(), "emuly-adb-"));
    return key ? await adbReplay.run(key, request.args, () => runAdb(request, directory)) : await runAdb(request, directory);
  } catch (error) {
    // A request that did not parse did not run.
    if (error instanceof HttpError) error.ran ??= false;
    throw error;
  } finally {
    adbBusy = false;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Runs one parsed adb request. Errors before adb starts (bad input, a file over the limit) did not run the command. */
async function runAdb(request, directory) {
  try {
    if (!(await booted())) throw new HttpError(409, "Android is not ready. Start the phone first.", false);
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
      if (!bugreport) {
        const size = await pullSize(args[1], async du => (await adbCapture(du, { timeout: 30_000, binary: false })).stdout);
        if (size !== undefined && size > ADB_DOWNLOAD_MAX_BYTES) throw new HttpError(413, "The file or folder on the phone is larger than 100 MB.");
      }
      const result = await adbCapture(command, { timeout: request.seconds * 1000 + 2000, binary: false });
      if (result.exitCode !== 0) throw new HttpError(502, result.stderr || `adb ${bugreport ? "bugreport" : "pull"} failed.`, true);
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
      throw new HttpError(502, result.stderr || "adb screenshot failed.", true);
    }
    return request.binary || isScreencap(args)
      ? { png: result.stdout }
      : { exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    // Errors before adb starts (bad input, a file over the limit) did not run the command.
    if (error instanceof HttpError) { error.ran ??= false; throw error; }
    const message = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 200);
    throw new HttpError(500, `adb could not finish: ${message}`, "unknown");
  }
}

// Retry key: see adb-replay.mjs. The key counts only with the same adb arguments.
const adbReplay = createAdbReplay();
function adbKeyed(req) {
  const key = req.headers["idempotency-key"];
  return adbRoute(req, undefined, typeof key === "string" && /^[\w.:-]{1,100}$/.test(key) ? key : undefined);
}
const apps = await createApps({ root: join(ROOT, "data", "app-installs"), sdk: SDK, run, adb, exclusive, booted });

/** Waits up to 60 s for the agent's adb slot, then holds it, so a fetch push and an agent adb call never overlap. */
async function withAdbSlot(work) {
  for (const until = Date.now() + 60_000; adbBusy;) {
    if (Date.now() > until) throw new AppError(409, "adb_busy", "Another adb command ran for too long. Retry the fetch.");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  adbBusy = true;
  try { return await work(); } finally { adbBusy = false; }
}
// File fetch (file-fetch.mjs): a public HTTPS file goes from the internet to the phone with no stop on the way.
// The dest passed fetchDest(): plain characters only, so it is safe inside the device shell quotes below.
const fetches = await createFileFetches({ root: join(ROOT, "data", "file-fetches"), booted,
  exists: dest => withAdbSlot(async () => {
    const result = await adbCapture(["shell", `test -e '${dest}' && echo yes || echo no`], { timeout: 15_000 });
    const answer = result.stdout.trim();
    if (answer !== "yes" && answer !== "no") throw new AppError(502, "phone_check_failed", "The phone did not answer the file check.");
    return answer === "yes";
  }),
  push: (local, dest) => withAdbSlot(async () => {
    const result = await adbCapture(["push", local, dest], { timeout: 300_000 });
    if (result.exitCode === 0) return;
    const text = `${result.stderr} ${result.stdout}`;
    if (/No space left|ENOSPC/i.test(text)) throw new AppError(507, "storage_full", "The phone does not have enough free storage.");
    throw new AppError(502, "push_failed", `adb push failed: ${text.replace(/\s+/g, " ").trim().slice(0, 200)}`);
  }) });
// The agent-device proxy runs only while this process does; its token never reaches a log.
// The runner owns SIGTERM (see the recorder below); the proxy stops in its exit handler.
const agentDevice = startAgentDeviceProxy({ sdk: SDK, signals: false });
const links = createLinks({ adb, booted });

// Egress gateway (egress.mjs): the emulator sends all TCP here. The mode survives a stop in
// /workspaces/.emuly/egress.json. In laptop mode, UDP other than DNS is dropped inside the
// phone, because CONNECT cannot carry it. The rules live in their own chain, so off is a flush.
const egress = createEgress({ log: message => console.log(message) });
await egress.load();
egress.listen().catch(error => console.log(`egress gateway failed: ${error.code ?? error.message}`));
queueMicrotask(() => { void applyUdpRules().catch(() => {}); });
let udpBlocked = false;
// Without --lock, a laptop proxy that dies with no Ctrl-C (a killed process, a closed laptop) must not
// leave the phone offline. After EGRESS_LOST_MS with no listener on the link port, go back to direct.
// With --lock the phone stays fail closed until `emuly proxy <phone> off`.
const EGRESS_LOST_MS = 90_000;
let egressLostAt;
setInterval(async () => {
  const now = egress.setting();
  if (now.mode !== "laptop" || now.lock) { egressLostAt = undefined; return; }
  if (await egress.upstreamOpen()) { egressLostAt = undefined; return; }
  egressLostAt ??= Date.now();
  if (Date.now() - egressLostAt < EGRESS_LOST_MS) return;
  egressLostAt = undefined;
  console.log("egress: the laptop proxy is gone, so the phone uses direct again");
  await egress.set({ mode: "direct" }).then(() => applyUdpRules()).catch(() => {});
}, 15_000).unref();
async function applyUdpRules() {
  const laptop = egress.setting().mode === "laptop";
  if (!await booted()) { udpBlocked = false; return; }
  const rules = laptop
    ? "for t in iptables ip6tables; do $t -N emuly_udp 2>/dev/null; $t -F emuly_udp; $t -C OUTPUT -j emuly_udp 2>/dev/null || $t -I OUTPUT -j emuly_udp; done; "
      + "iptables -A emuly_udp -p udp ! -d 10.0.2.3 -j DROP; ip6tables -A emuly_udp -p udp -j DROP; echo emuly-ok"
    : "for t in iptables ip6tables; do $t -F emuly_udp 2>/dev/null; done; echo emuly-ok";
  // su 0 keeps adbd as it is. adb root would restart adbd and cut scrcpy and every adb session.
  const out = String(await adb(["shell", `su 0 sh -c '${rules}'`], { timeout: 15_000 }).catch(error => error.stdout ?? ""));
  udpBlocked = laptop && out.includes("emuly-ok");
  if (laptop && !udpBlocked) console.log("egress: could not drop UDP in the phone");
}
async function egressStatus() {
  const status = egress.status();
  const dns = await readFile("/tmp/emuly-dns.log", "utf8").then(text => text.includes("emuly dns on"), () => false);
  return { ...status, laptop_connected: status.mode === "laptop" ? await egress.upstreamOpen() : null,
    dns: dns ? (status.mode === "laptop" ? "laptop" : "codespace") : "codespace", udp: udpBlocked ? "blocked" : "open" };
}
// A new runner has no links, so any reverse rule on the phone is left from the last runner.
void links.sweep().catch(() => {});

// Push "boot.ready" or "boot.failed" to Emuly (events.mjs). Fire and forget: it retries on its own.
const events = createEvents({ file: join(ROOT, ".events"), log: message => console.log(message) });
let bootAttempt;
function pushBoot(ok) {
  if (bootAttempt) void events.send(ok ? "boot.ready" : "boot.failed", bootAttempt);
}

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

// GET /ui (ui-tree.mjs): the UI tree as JSON, with retries for "null root node".
const ui = createUiReader({ adb });

const routes = {
  "GET /health": async () => ({ ok: true, version: 31, key: await runnerKey.fingerprint(), scripts: SCRIPTS_VERSION, capabilities: ["appsInventory", "apkUpload", "urlInstall", "appLaunch", "clipboard", "adbPassthrough", "adbFiles", "unicodeText", "links", "netCheck", "sharedStream", "directStream", "directUpload", "pushEvents", "frameGrid", "screenshotScale", "fileFetch", "uiTree", "egress"], avd: "t", api_level: 36, booted: await booted(),
    busy: { viewers: scrcpy.viewers(), links: links.count(), work: requestsInFlight + lifecycleWork + fetches.active() + (adbBusy ? 1 : 0) + (boot || stopping ? 1 : 0),
      idle_ms: Date.now() - lastRequestAt } }),

  "POST /boot": ({ diagnosticOperation, attempt }) => {
    if (stopSettled) { stopping = undefined; stopSettled = false; }
    // Emuly sends its boot attempt id; a retry that joins this boot sends the newer one.
    if (typeof attempt === "string" && attempt.length <= 40) bootAttempt = attempt;
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
      await applyUdpRules().catch(() => {});
      return { booted: await booted(), seconds: Math.round((Date.now() - start) / 1000) };
    }).then(result => { pushBoot(result.booted); return result; }, error => { pushBoot(false); throw error; })
      .finally(() => { boot = undefined; });
  },

  // GitHub's port forward ends a request after about 100 s, but stop.sh may wait 120 s for qemu.
  // So answer within 80 s. A later POST /stop joins the same stop and reports its result.
  "POST /stop": async () => {
    if (!stopping) stopSettled = false;
    stopping ??= (async () => { await apps.stop(); return exclusive(async () => {
      const start = Date.now();
      scrcpy.closeAll();
      for (const client of streams.clients) client.close();
      direct.revoke();
      links.clear();
      await script("stop.sh");
      return { stopped: true, seconds: Math.round((Date.now() - start) / 1000) };
    }); })().finally(() => {
      stopSettled = true;
      // A late POST /stop within 60 s still joins this result. Clear only this stop, not a newer one.
      const settled = stopping;
      setTimeout(() => { if (stopping === settled) { stopping = undefined; stopSettled = false; } }, 60_000);
    });
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
  "GET /file-fetches": () => fetches.list(),
  "POST /file-fetches": body => fetches.create(body),
  "GET /agent-device-info": () => agentDevice.info(),

  // Links. The body of each call is small JSON; see links.mjs.
  "GET /links": () => links.list(),
  "POST /links": body => links.add(body),
  "POST /links/remove": body => links.remove(body),
  "POST /net-check": body => links.netCheck(body),
  "GET /link-hints": async () => ({ logcat: await links.hints() }),

  // Egress (egress.mjs). POST /egress { mode: "direct" | "laptop", port?, lock? }.
  "GET /egress": () => egressStatus(),
  "POST /egress": async body => { await egress.set(body); await applyUdpRules(); return egressStatus(); },
  "POST /egress/check": () => egress.check(),

  // Screen recording (recording.mjs): an MP4 made from the shared video stream, with no second encoder.
  "POST /recording/start": body => recorder.start(body),
  "POST /recording/stop": () => recorder.stop(),
  "POST /recording/discard": () => recorder.discard(),
  "GET /recording": () => recorder.status(),
  "POST /recording/mark": body => recorder.mark(body),
  "GET /recording/notes": () => recorder.notes(),

  // Private: closes direct (port 8791) sockets. Emuly calls it on logout, stop, and delete.
  "POST /direct/revoke": ({ userId }) => {
    if (userId !== undefined && !Number.isSafeInteger(userId)) throw new HttpError(400, "bad user");
    return { closed: direct.revoke(userId) };
  },

};

const server = createServer(async (req, res) => {
  const send = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    // GET /health stays open for the setup script's local curl. Everything else needs the runner key.
    if (!(req.method === "GET" && path === "/health") && !await runnerKey.allows(req.headers["x-phone-secret"])) {
      return send(401, { error: "unauthorized" });
    }
    if (path !== "/health") {
      requestsInFlight++; lastRequestAt = Date.now();
      res.once("close", () => { requestsInFlight--; lastRequestAt = Date.now(); });
    }
    const fetchJob = path.match(/^\/file-fetches\/([0-9a-f-]{36})(?:\/(cancel))?$/);
    if (fetchJob) {
      const [, id, action] = fetchJob;
      if (req.method === "GET" && !action) return send(200, fetches.status(id));
      if (req.method === "POST" && action === "cancel") return send(200, await fetches.cancel(id));
      return send(405, { error: "Method not allowed." });
    }
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
      const result = await adbKeyed(req);
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
    // Frame grid: one JPEG of frames at ?fps=, with each frame's time (grid.mjs).
    if (req.method === "GET" && path === "/recording/grid") {
      const options = gridOptions(url.searchParams);
      const { path: file, durationMs } = await recorder.file();
      const { jpeg, layout } = await makeGrid({ path: file, durationMs, options });
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(jpeg.length), "cache-control": "no-store",
        "x-grid-frames": String(layout.frames), "x-grid-page": String(options.page), "x-grid-pages": String(layout.pages),
        "x-grid-start-ms": String(Math.round(layout.startS * 1000)), "x-grid-fps": String(options.fps), "x-grid-cols": String(layout.cols) });
      return res.end(jpeg);
    }
    if (req.method === "GET" && path === "/ui") return send(200, await ui.read({ all: url.searchParams.get("all") === "1" }));
    // A smaller screenshot (?scale=0.5) costs the agent fewer image tokens. No scale: the full PNG.
    if (req.method === "GET" && path === "/screenshot" && url.searchParams.has("scale")) {
      const scale = screenshotScale(url.searchParams);
      const full = await screenshot();
      const png = scale ? await scalePng(full, scale) : full;
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "x-screenshot-scale": String(scale ?? 1) });
      return res.end(png);
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
    send(error.status ?? 500, { error: error.status ? error.message : "Phone operation failed.", errorCode: error.code ?? "runner_error",
      ...(error.ran !== undefined ? { ran: error.ran } : {}), ...(error.replayed ? { replayed: true } : {}) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`runner listening on 127.0.0.1:${PORT}`));

// One shared scrcpy session per quality (scrcpy-hub.mjs). EMULY_SHARED_STREAM=0 gives each viewer its own.
const scrcpy = createHub({ open: quality => openScrcpy({ adb, ADB, SERIAL, ROOT, quality }),
  share: process.env.EMULY_SHARED_STREAM !== "0" });
// Recordings live next to the runner, not in /tmp, so a file survives a runner restart.
const recorder = createRecorder({ attach: (socket, quality) => scrcpy.attach(socket, quality, { audio: true }), qualities,
  dir: join(ROOT, "recordings") });
// Finish a recording that a killed runner left without MP4 tables (recording.mjs).
void recorder.recover();
// start-runner.sh and a codespace stop send SIGTERM: write the MP4 tables before exit.
// The 5 s limit keeps a stuck disk from holding the process; recover() handles the rest later.
for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) process.once(signal, () => {
  setTimeout(() => process.exit(code), 5000).unref();
  recorder.close().catch(() => {}).finally(() => process.exit(code));
});
// The public direct port (direct-server.mjs). The key file is written by the server's private setup.
const direct = createDirectServer({ ws, keyFile: join(ROOT, ".direct-key"), port: Number(process.env.DIRECT_PORT ?? 8791),
  qualities: liveQualities, log: message => console.log(message),
  // Direct upload: the ticket carries the args. Only file commands get a ticket, so the result is JSON.
  upload: (req, ticket) => adbRoute(req, ticket),
  attach: (client, quality, options) => scrcpy.attach(client, quality, options) });
void direct.start();
const streams = new ws.WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
const relays = new ws.WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_PAYLOAD, perMessageDeflate: false });
server.on("upgrade", async (req, socket, head) => {
  socket.on("error", () => {});
  lastRequestAt = Date.now();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!await runnerKey.allows(req.headers["x-phone-secret"])) return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  if (url.pathname === "/links/relay") {
    const ports = (url.searchParams.get("ports") ?? "").split(",").filter(Boolean).map(Number);
    return relays.handleUpgrade(req, socket, head, client => links.relay(client, ports));
  }
  if (url.pathname !== "/stream") return socket.destroy();
  streams.handleUpgrade(req, socket, head, client => {
    const quality = url.searchParams.get("quality") ?? "auto";
    scrcpy.attach(client, Object.hasOwn(liveQualities, quality) ? quality : "auto", { audio: url.searchParams.get("audio") === "1" });
  });
});
