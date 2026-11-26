#!/usr/bin/env node
// Emuly CLI: `emuly up|login|doctor|install|link|dev|proxy|unlink|links`. Plain Node, no dependencies. Used on the host
// (`pnpm emuly up`) and as the container command (`node bin/emuly.mjs up --prod --no-browser`).
// All interactive child output is inherited, so the user sees gh's device-flow code and the
// server log. Checks run with piped output so their stderr can be shown on failure.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer as createNetServer, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// gh's device flow needs no OAuth App: the credential store (a named volume in a container)
// holds the token, and `gh auth token` hands it to the app at request time.
const LOGIN_ARGS = ["auth", "login", "-h", "github.com", "-s", "codespace"];
const REFRESH_ARGS = ["auth", "refresh", "-h", "github.com", "-s", "codespace"];

// Podman leaves /run/.containerenv, Docker leaves /.dockerenv. Both need the compose
// wording, because running gh on the host would store the token outside the volume.
const inContainer = () => existsSync("/.dockerenv") || existsSync("/run/.containerenv");

function spawnClose(file, args, stdio) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    if (child.stdout) child.stdout.on("data", chunk => { stdout += chunk; });
    if (child.stderr) child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout.trim())
      : reject(Object.assign(new Error(`${file} ${args[0]} failed`), { code, stderr })));
  });
}

// Interactive commands (login, the server) show their output directly; probes stay quiet.
const probe = (file, args) => spawnClose(file, args, "ignore");
const quiet = (file, args) => spawnClose(file, args, "inherit");

/** gh >= 2.103 refreshes expiring tokens inside `gh auth token`; older gh hits expiry at
    request time. gh < 2.103 still works on hosts that never issue expiring tokens, so warn. */
async function ghVersionWarning() {
  const version = await probe("gh", ["--version"]).catch(() => "");
  const match = /(\d+)\.(\d+)\.\d+/.exec(version) ?? [];
  const [major = 0, minor = 0] = match.slice(1).map(Number);
  // An empty probe means gh itself is missing; the caller reports that already.
  if (!version) return;
  if (major < 2 || (major === 2 && minor < 103)) {
    console.warn(`Warning: gh ${version.split("\n")[0] || "version unknown"} predates 2.103 and cannot refresh expiring tokens. Self-host relies on that; upgrade gh from https://cli.github.com.`);
  }
}


/** gh's stderr says what actually went wrong; show it after our one-line hint. */
function report(error) {
  console.error(error.message);
  const stderr = (error.stderr ?? "").trim();
  if (stderr) console.error(stderr);
}

/** Inspect granted OAuth scopes directly; API failures retain their real diagnostics. */
async function hasCodespaceScope() {
  const response = await probe("gh", ["api", "-i", "user"]);
  const header = /^x-oauth-scopes:\s*(.*)$/im.exec(response);
  if (!header) throw new Error("GitHub did not return X-OAuth-Scopes; cannot verify the codespace scope. Use `emuly login` with gh's OAuth credential store.");
  return header[1].split(",").map(scope => scope.trim()).includes("codespace");
}

/** Check the credential store, then the actual OAuth scopes. */
async function scopeReady() {
  try { await probe("gh", ["auth", "status"]); } catch {
    console.error("\nNo GitHub account in gh's credential store. Run:");
    console.error(`\n  ${inContainer() ? "docker compose run --rm emuly gh auth login -h github.com -s codespace"
      : "gh auth login -h github.com -s codespace"}\n`);
    return false;
  }
  let ready;
  try { ready = await hasCodespaceScope(); }
  catch (error) { report(error); return false; }
  if (!ready) {
    console.error("\nThe gh account is missing the codespace scope. Run:");
    console.error(`\n  ${inContainer() ? "docker compose run --rm emuly gh auth refresh -h github.com -s codespace"
      : "gh auth refresh -h github.com -s codespace"}\n`);
    return false;
  }
  return true;
}

async function up(args) {
  await probe("gh", ["--version"]).catch(() => {
    throw new Error("The gh CLI is not installed. Install it from https://cli.github.com first.");
  });
  await ghVersionWarning();
  // GH_TOKEN bypasses gh's store: `gh auth token` then returns a token that usually lacks
  // the codespace scope, and the login flow below would not repair it. Refuse to start.
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    throw new Error("GH_TOKEN/GITHUB_TOKEN is set. Unset it so Emuly uses gh's own credential store, which `emuly login` fills with the codespace scope.");
  }
  if (!await scopeReady()) { process.exitCode = 1; return; }

  console.log("Running database migrations…");
  await quiet("node", ["--experimental-strip-types", "scripts/migrate-database.ts"]);

  // The flag must also have been set when the bundle was built; middleware inlines it
  // at build time, so serving a prod build made without it leaves self-host compiled out.
  if (args.includes("--prod") && process.env.EMULY_SELF_HOST !== "1") {
    console.warn("Warning: EMULY_SELF_HOST is not set in this shell. If this prod build was made without the flag, self-host code is compiled out; build with EMULY_SELF_HOST=1 pnpm build.");
  }

  const url = `http://localhost:${process.env.PORT ?? 4321}`;
  console.log(`Starting emuly on ${url}\n`);
  // An installed emuly-playbook skill reads this file before its install-time base, so a
  // skill first installed from the hosted site still finds this server. On the host only:
  // inside a container the file would land in the container, not where the agent runs.
  if (!inContainer()) {
    try {
      const dir = join(homedir(), ".config", "emuly");
      mkdirSync(dir, { recursive: true });
      // A tailnet or proxy address set in EMULY_BASE_URL is the one agents must call.
      writeFileSync(join(dir, "base-url"), `${(process.env.EMULY_BASE_URL || url).replace(/\/$/, "")}\n`);
    } catch (error) { console.warn(`Could not write ~/.config/emuly/base-url: ${error.message}`); }
  }
  if (!inContainer() && process.stdout.isTTY && !args.includes("--no-browser")) {
    // Detached: the browser outlives a Ctrl-C of the server. Without an error listener a
    // missing xdg-open becomes an uncaught exception; the URL is printed above anyway.
    const open = { linux: "xdg-open", darwin: "open", win32: "cmd" }[process.platform];
    if (open) spawn(open, open === "cmd" ? ["/c", "start", "", url] : [url], { stdio: "ignore", detached: true })
      .on("error", () => {}).unref();
  }

  // A child that survives this process would keep the port, so forward both stop signals.
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url)), ...(args.includes("--prod") ? ["--production"] : [])],
    { stdio: "inherit", env: { ...process.env, EMULY_SELF_HOST: "1" } });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("close", code => process.exit(code ?? 1));
}

async function login() {
  await probe("gh", ["--version"]).catch(() => {
    throw new Error("The gh CLI is not installed. Install it from https://cli.github.com first.");
  });
  // Logged in but without the scope needs a refresh; a fresh store needs the full login.
  // Inherited stdio shows the one-time device code and gh's prompts.
  try { await probe("gh", ["auth", "status"]); await quiet("gh", REFRESH_ARGS); }
  catch { await quiet("gh", LOGIN_ARGS); }
}

async function doctor() {
  let failed = false;
  const fail = message => { console.error(`  ✗ ${message}`); failed = true; };
  const ok = message => console.log(`  ✓ ${message}`);
  await probe("gh", ["--version"]).then(out => ok(`gh is installed: ${out.split("\n")[0]}`))
    .catch(() => fail("gh is not installed. Install it from https://cli.github.com."));
  await ghVersionWarning().catch(() => {});
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    fail("GH_TOKEN/GITHUB_TOKEN is set. It bypasses gh's credential store, which is where Emuly's token lives.");
  }
  await probe("gh", ["auth", "status"]).then(() => ok("gh has a signed-in account"))
    .catch(() => fail(inContainer()
      ? "gh has no signed-in account. Run `docker compose run --rm emuly gh auth login -h github.com -s codespace`."
      : "gh has no signed-in account. Run `emuly login`."));
  await hasCodespaceScope().then(ready => {
    if (ready) ok("the gh token has the codespace scope");
    else fail(inContainer()
      ? "the gh token lacks the codespace scope. Run `docker compose run --rm emuly gh auth refresh -h github.com -s codespace`."
      : "the gh token lacks the codespace scope. Run `gh auth refresh -h github.com -s codespace`.");
  }).catch(error => { fail("Could not verify GitHub scopes. Check the API error below."); report(error); });
  await probe("gh", ["api", "user", "--jq", ".login"]).then(login => ok(`GitHub identity: ${login} (active account; switch with gh auth switch -h github.com)`))
    .catch(error => { fail("`gh api user` failed. Check connectivity."); report(error); });
  await probe("gh", ["auth", "token"]).then(() => ok("`gh auth token` returned a token"))
    .catch(() => fail(inContainer()
      ? "`gh auth token` failed. Run `docker compose run --rm emuly gh auth login -h github.com -s codespace`."
      : "`gh auth token` failed. Run `emuly login`."));
  // The database can live elsewhere through EMULY_DB; check the directory that will hold it.
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const directory = (process.env.EMULY_DB || ".data/emuly.db").replace(/[^/\\]*$/, "") || ".";
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}.emuly-doctor-probe`, "1");
    rmSync(`${directory}.emuly-doctor-probe`);
    ok(`the database directory (${directory}) is writable`);
  } catch { fail(`the database directory (${directory}) is not writable`); }
  if (failed) { process.exitCode = 1; console.error("\nFix the ✗ items, then run `emuly up`."); }
  else console.log("\nEverything checks out. Run `emuly up`.");
}

// ---------------------------------------------------------------------------------------------
// Links. The laptop always opens the connection outward:
// Route A (ssh): `gh codespace ssh -- -R`, the bytes go through GitHub only.
// Route B (relay): one websocket to the Emuly control plane, which relays it to the runner.
// Each TCP connection from the app is one numbered stream inside the tunnel.

const FRAME = { OPEN: 1, DATA: 2, CLOSE: 3 };
const RELAY_CHUNK = 64 * 1024;
const HIGH_WATER = 1024 * 1024;
const FATAL_CLOSE = new Map([[4400, "The runner refused the ports."], [4404, "The runner has no relay link for a port."],
  [4409, "A process in the codespace already uses this port. Stop it, or link another port."]]);

/** The same order as the skill: environment, then the saved file, then (Windows) the user variable. */
function emulyKey() {
  if (process.env.EMULY_KEY) return process.env.EMULY_KEY.trim();
  try { const key = readFileSync(join(homedir(), ".config", "emuly", "key"), "utf8").trim(); if (key) return key; } catch {}
  if (process.platform === "win32") {
    const out = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "EMULY_KEY"], { encoding: "utf8" }).stdout ?? "";
    const match = /EMULY_KEY\s+REG_\w+\s+(\S+)/.exec(out);
    if (match) return match[1];
  }
  throw new Error("No Emuly key. Set EMULY_KEY, or save it in ~/.config/emuly/key.");
}

function emulyBase() {
  if (process.env.EMULY_BASE_URL) return process.env.EMULY_BASE_URL.trim().replace(/\/$/, "");
  try { const base = readFileSync(join(homedir(), ".config", "emuly", "base-url"), "utf8").trim(); if (base) return base.replace(/\/$/, ""); } catch {}
  throw new Error("No Emuly base URL. Set EMULY_BASE_URL, or write it to ~/.config/emuly/base-url.");
}

async function api(method, path, body) {
  const response = await fetch(`${emulyBase()}${path}`, { method, signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${emulyKey()}`, "x-emuly-client": cliClient(), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let value = {};
  try { value = await response.json(); } catch {}
  if (!response.ok) {
    throw Object.assign(new Error(value.message ?? value.error ?? `Emuly returned ${response.status}.`), { status: response.status, body: value });
  }
  return value;
}

/** stdout carries JSON only, so an agent can parse it. People read stderr. */
const say = message => console.error(`emuly link: ${message}`);
const emit = value => console.log(JSON.stringify(value));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function linkArgs(args) {
  const ports = [], options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--to" || arg === "--route") { options[arg.slice(2)] = args[++index]; continue; }
    if (arg.startsWith("--to=") || arg.startsWith("--route=")) { const [key, value] = arg.slice(2).split(/=(.*)/); options[key] = value; continue; }
    if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}.`);
    if (!options.phone) { options.phone = arg; continue; }
    if (!/^\d{1,5}$/.test(arg)) throw new Error(`"${arg}" is not a port.`);
    ports.push(Number(arg));
  }
  if (!options.phone || !ports.length) throw new Error("Usage: emuly link <phone> <port>... [--to host[:port]] [--route ssh|relay]");
  if (options.route && !["ssh", "relay"].includes(options.route)) throw new Error("--route is ssh or relay.");
  // --to host:port fits one port; --to host keeps each port number.
  let host = "127.0.0.1", targetPort;
  if (options.to) {
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(options.to);
    if (!match) throw new Error("--to is host or host:port.");
    host = match[1].replace(/^\[(.*)\]$/, "$1");
    if (match[2]) {
      if (ports.length > 1) throw new Error("--to host:port fits one port. Use --to host for several ports.");
      targetPort = Number(match[2]);
    }
  }
  const targets = new Map(ports.map(port => [port, { host, port: targetPort ?? port }]));
  return { phone: options.phone, ports, targets, route: options.route };
}

/** Section 5 of the plan: gh logged in gives Route A if one of its accounts can open the codespace. */
async function pickRoute() {
  if (!await probe("gh", ["--version"]).then(() => true, () => false)) {
    return { route: "relay", reason: "gh is not installed" };
  }
  if (!await probe("gh", ["auth", "status"]).then(() => true, () => false)) {
    return { route: "relay", reason: "gh is not logged in", tip: "gh auth login -s codespace makes links faster" };
  }
  return { route: "ssh" };
}

/** Runs gh with an environment. Resolves the exit code and all output; never rejects on a non-zero exit. */
function ghRun(args, env = process.env) {
  return new Promise(resolve => {
    const child = spawn("gh", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", () => resolve({ code: -1, output }));
    child.on("close", code => resolve({ code, output }));
  });
}

/**
 * The environment for a gh account that can open this codespace. The active account goes first.
 * Then each other account in gh, through GH_TOKEN for this process only: `gh auth switch` would
 * change the user's setup. Undefined when no account can open it (wrong owner, or no codespace scope).
 */
async function ghEnvFor(codespace, owner) {
  const opens = async env => (await ghRun(["codespace", "view", "-c", codespace, "--json", "name"], env)).code === 0;
  if (await opens(process.env)) return process.env;
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return undefined;
  // The server names the owner (github_login), so try that account first and only.
  const { output } = await ghRun(["auth", "status", "--hostname", "github.com"]);
  const known = [...new Set([...output.matchAll(/account (\S+)/g)].map(match => match[1]))];
  const accounts = owner ? known.filter(account => account.toLowerCase() === owner.toLowerCase()) : known;
  if (owner && !accounts.length) { say(`gh has no login for ${owner}, which owns this codespace.`); return undefined; }
  for (const account of accounts) {
    const token = await ghRun(["auth", "token", "--hostname", "github.com", "--user", account]);
    if (token.code !== 0 || !token.output.trim()) continue;
    const env = { ...process.env, GH_TOKEN: token.output.trim() };
    if (await opens(env)) { say(`using the gh account ${account}, which owns this codespace.`); return env; }
  }
  return undefined;
}

const relayAvailable = () => typeof globalThis.WebSocket === "function";

/** True when something accepts a TCP connection at host:port within 2 s. */
function portOpen(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const done = open => { socket.destroy(); resolve(open); };
    socket.setTimeout(2_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * GET /v1/cli serves the CLI of the server. When its SHA-256 differs from this file, the CLI replaces
 * itself with the server copy: it downloads it, checks the SHA-256, and renames it over this file.
 * The new copy runs from the next command. It does not replace the file in a git clone, or when
 * EMULY_CLI_AUTO_UPDATE=0. Then it only says how to update. A network failure is silent.
 */
const sha256 = text => createHash("sha256").update(text).digest("hex");
/** "cli/<first 7 hex of this file's SHA-256>". Diagnostics count calls by this version; it holds no user data. */
let clientHeader;
function cliClient() {
  if (!clientHeader) {
    try { clientHeader = `cli/${sha256(readFileSync(fileURLToPath(import.meta.url), "utf8").split(String.fromCharCode(13)).join("")).slice(0, 7)}`; }
    catch { clientHeader = "cli"; }
  }
  return clientHeader;
}
const sayCli = message => console.error(`emuly: ${message}`);
/**
 * The hash comes in the same response as the code, so it proves only that the download is whole.
 * Only TLS proves where the code comes from. Plain http is allowed only to this computer (self-host, dev).
 */
function secureUpdateUrl(url) {
  const { protocol, hostname } = new URL(url);
  if (protocol === "https:") return true;
  return protocol === "http:" && (hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname));
}
async function updateCli() {
  const self = fileURLToPath(import.meta.url);
  let url;
  try { url = `${emulyBase()}/v1/cli`; } catch { return; }
  const manual = `the server has a newer emuly.mjs. Get it with: curl -fsSL ${url} -o "${self}"`;
  try {
    const mine = sha256(readFileSync(self, "utf8").split(String.fromCharCode(13)).join(""));
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5_000) });
    const theirs = response.headers.get("x-emuly-cli-sha256");
    if (!response.ok || !theirs || theirs === mine) return;
  } catch { return; }
  if (process.env.EMULY_CLI_AUTO_UPDATE === "0" || existsSync(join(dirname(self), "..", ".git"))) { sayCli(manual); return; }
  if (!secureUpdateUrl(url)) { sayCli(`the server is not https, so this copy does not update itself. ${manual}`); return; }
  // The .mjs ending lets node --check read the file as a module.
  const temporary = `${self}.${process.pid}.tmp.mjs`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await response.text();
    const sent = response.headers.get("x-emuly-cli-sha256");
    if (!response.ok || !sent || sha256(body) !== sent) {
      sayCli(`the new emuly.mjs did not match its SHA-256, so this copy stays. ${manual}`);
      return;
    }
    writeFileSync(temporary, body);
    // A file that does not parse never replaces a working CLI.
    if (spawnSync(process.execPath, ["--check", temporary], { stdio: "ignore", timeout: 30_000 }).status !== 0) {
      rmSync(temporary, { force: true });
      sayCli(`the new emuly.mjs did not parse, so this copy stays. ${manual}`);
      return;
    }
    copyFileSync(self, `${self}.bak`);
    renameSync(temporary, self);
    sayCli(`updated emuly.mjs from the server. The new copy runs from the next command. The old copy is ${self}.bak.`);
  } catch {
    rmSync(temporary, { force: true });
    sayCli(manual);
  }
}

async function phoneRunning(phone) {
  try { return (await api("GET", `/v1/phones/${encodeURIComponent(phone)}`)).state === "running"; }
  catch (error) { return error.status === 404 ? false : true; }
}

/** Waits until the runner sees every port: sshd listens (ssh) or the relay is connected (relay). */
async function linkReady(phone, ports, route, alive, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until && alive()) {
    try {
      const { links = [] } = await api("GET", `/v1/phones/${encodeURIComponent(phone)}/links`);
      const ready = ports.every(port => links.some(link => link.port === port && link.route === route
        && (route === "ssh" ? link.listening : link.relay_connected)));
      if (ready) return true;
    } catch {}
    await wait(1000);
  }
  return false;
}

/** Route A. Resolves "stopped" on Ctrl-C, or rejects with the reason when ssh ends. */
function runSsh(codespace, targets, onReady, stopSignal, env = process.env, locals = []) {
  return new Promise((resolve, reject) => {
    const args = ["codespace", "ssh", "-c", codespace, "--", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
      ...(locals.length ? ["-C"] : []), ...locals.flatMap(spec => ["-L", spec]),
      ...[...targets].flatMap(([port, target]) => ["-R", `${port}:${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`])];
    const child = spawn("gh", args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "", running = true;
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on("error", error => { running = false; reject(error); });
    child.on("close", code => { running = false; reject(Object.assign(new Error(`gh codespace ssh ended (exit ${code}).`), { stderr })); });
    stopSignal.addEventListener("abort", () => { child.kill(); resolve("stopped"); }, { once: true });
    onReady(() => running);
  });
}

/** Route B. One websocket; each OPEN frame becomes one TCP connection to its target. */
function runRelay(url, targets, onReady, stopSignal) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const streams = new Map(), paused = new Set();
    let open = false;
    const send = (type, id, body) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const extra = type === FRAME.DATA ? body.length : type === FRAME.OPEN ? 2 : 0;
      const frame = Buffer.allocUnsafe(5 + extra);
      frame.writeUInt8(type, 0); frame.writeUInt32BE(id, 1);
      if (type === FRAME.DATA) body.copy(frame, 5);
      ws.send(frame);
    };
    const drain = setInterval(() => {
      if (!paused.size || ws.bufferedAmount > HIGH_WATER / 2) return;
      for (const socket of paused) socket.resume();
      paused.clear();
    }, 50);
    const finish = () => { clearInterval(drain); for (const socket of streams.values()) socket.destroy(); streams.clear(); };
    stopSignal.addEventListener("abort", () => { ws.close(1000, "stopped"); finish(); resolve("stopped"); }, { once: true });
    ws.addEventListener("open", () => { open = true; onReady(() => ws.readyState === WebSocket.OPEN); });
    ws.addEventListener("message", event => {
      if (typeof event.data === "string") return;
      const frame = Buffer.from(event.data);
      if (frame.length < 5) return;
      const type = frame.readUInt8(0), id = frame.readUInt32BE(1);
      if (type === FRAME.OPEN && frame.length === 7) {
        const target = targets.get(frame.readUInt16BE(5));
        if (!target) return send(FRAME.CLOSE, id);
        const socket = connect({ host: target.host, port: target.port });
        socket.setNoDelay(true);
        streams.set(id, socket);
        socket.on("data", chunk => {
          for (let at = 0; at < chunk.length; at += RELAY_CHUNK) send(FRAME.DATA, id, chunk.subarray(at, at + RELAY_CHUNK));
          if (ws.bufferedAmount > HIGH_WATER) { socket.pause(); paused.add(socket); }
        });
        const done = () => { if (streams.delete(id)) { paused.delete(socket); send(FRAME.CLOSE, id); } };
        socket.on("end", done);
        socket.on("close", done);
        socket.on("error", () => socket.destroy());
      } else if (type === FRAME.DATA) {
        streams.get(id)?.write(frame.subarray(5));
      } else if (type === FRAME.CLOSE) {
        const socket = streams.get(id);
        streams.delete(id);
        socket?.end();
      }
    });
    ws.addEventListener("error", event => { say(`relay error: ${event.error?.message ?? event.message ?? "unknown"}`); });
    ws.addEventListener("close", event => {
      finish();
      if (stopSignal.aborted) return;
      // 4012: the server ends each relay before its time limit. Reconnect at once; it is not a failure.
      if (open && event.code === 4012) { resolve("reconnect"); return; }
      reject(Object.assign(new Error(FATAL_CLOSE.get(event.code) ?? (open ? `The relay closed (${event.code}).` : "The relay could not connect.")),
        { fatal: FATAL_CLOSE.has(event.code), code: event.code }));
    });
  });
}

async function link(args) {
  const { phone, ports, targets, route: forced } = linkArgs(args);
  const stop = new AbortController();
  // Ctrl-C removes the links on the phone, so no stale adb reverse rule stays behind.
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop.abort());
  await holdLink({ phone, ports, targets, forced, stop });
}

/**
 * Keeps links up until `stop` aborts, with reconnects. `onUp(route, verified)` runs once when the
 * link first works; without it, the link prints its JSON line. `emuly proxy` uses it too.
 */
async function holdLink({ phone, ports, targets, forced, stop, onUp }) {
  const path = `/v1/phones/${encodeURIComponent(phone)}/links`;

  let choice = forced ? { route: forced } : await pickRoute();
  // Route A needs a gh account that can open this phone's codespace. Find it before the first try.
  let ghEnv;
  if (choice.route === "ssh") {
    const current = await api("GET", path).catch(() => ({}));
    ghEnv = current.codespace_name ? await ghEnvFor(current.codespace_name, current.github_login) : undefined;
    if (!ghEnv && forced) {
      emit({ ok: false, error: "no_gh_account", message: "No gh account can open this phone's codespace. It needs the account that owns it, with the codespace scope." });
      process.exitCode = 1;
      return;
    }
    if (!ghEnv) choice = { route: "relay", reason: "no gh account can open this phone's codespace",
      tip: "gh auth login -s codespace with the account that owns the codespace makes links faster" };
  }
  if (choice.reason) say(`using the relay: ${choice.reason}.${choice.tip ? ` Tip: ${choice.tip}.` : ""}`);
  // The link works without a server on this computer, but the app gets no reply. Say so now.
  const listeningHere = new Map();
  for (const [port, target] of targets) {
    const open = await portOpen(target.host, target.port);
    listeningHere.set(port, open);
    if (!open) say(`nothing listens on ${target.host}:${target.port} on this computer yet. Start the server; the link waits for it.`);
  }
  if (choice.route === "relay" && !relayAvailable()) {
    emit({ ok: false, error: "no_route", message: "No route works here. The relay needs Node 22 or later, and gh is not ready. Ask the user to permit one install of the GitHub CLI." });
    process.exitCode = 2;
    return;
  }

  let announced = false, failures = 0;
  const announce = (route, verified) => {
    if (announced) { say(`reconnected (${route}).`); return; }
    announced = true;
    if (onUp) { void onUp(route, verified); return; }
    emit({ ok: true, verified, phone, route, ports, targets: [...targets].map(([port, target]) => ({ port, to: `${target.host}:${target.port}`,
      listening_here: listeningHere.get(port) })),
      app_urls: ports.flatMap(port => [`localhost:${port}`, `10.0.2.2:${port}`]) });
  };

  while (!stop.signal.aborted) {
    let created;
    try { created = await api("POST", path, { ports, route: choice.route }); }
    catch (error) {
      if (error.status === 400 || error.status === 404 || error.status === 409 || error.status === 401) {
        emit({ ok: false, error: error.body?.error ?? "link_failed", message: error.message });
        process.exitCode = 1;
        return;
      }
      created = undefined;
      say(`could not create the link: ${error.message}`);
    }
    if (created) {
      const ready = alive => void linkReady(phone, ports, choice.route, alive).then(ok => {
        if (ok) { failures = 0; announce(choice.route, true); }
        // The tunnel runs, but the runner did not report the port in 30 s. Say so; do not hide it.
        else if (alive() && !announced) { say("the tunnel runs, but the runner does not see the port yet."); announce(choice.route, false); }
      });
      try {
        const result = choice.route === "ssh"
          ? await runSsh(created.codespace_name, targets, ready, stop.signal, ghEnv)
          : await runRelay(`${emulyBase().replace(/^http/, "ws")}${path}/relay?ticket=${encodeURIComponent(created.ticket)}`, targets, ready, stop.signal);
        if (result === "stopped") break;
        if (result === "reconnect") continue;
      } catch (error) {
        if (stop.signal.aborted) break;
        const detail = (error.stderr ?? "").trim().split("\n").pop();
        say(`${error.message}${detail ? ` ${detail}` : ""}`);
        if (error.fatal) { emit({ ok: false, error: "link_failed", message: error.message }); process.exitCode = 1; break; }
        // Route A never worked (wrong gh account, no -R support): fall back to the relay once, as the plan says.
        if (choice.route === "ssh" && !announced && !forced && relayAvailable()) {
          choice = { route: "relay" };
          say("using the relay: gh codespace ssh did not work for this phone.");
          continue;
        }
      }
    }
    if (stop.signal.aborted) break;
    if (!await phoneRunning(phone)) {
      say("the phone stopped, so the link ended.");
      if (!announced) emit({ ok: false, error: "phone_not_running", message: "The phone is not running." });
      process.exitCode = announced ? 0 : 1;
      return;
    }
    failures++;
    if (!announced && failures >= 3) {
      emit({ ok: false, error: "link_failed", message: "The link did not start after 3 tries. Read the lines above." });
      process.exitCode = 1;
      break;
    }
    await wait(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
  }
  // Remove only the ports of this process; another `emuly link` may own other ports.
  for (const port of ports) await api("DELETE", `${path}?port=${port}`).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// `emuly dev`: connects the phone to adb on this computer, so flutter, expo and Android Studio see it.
// One `gh codespace ssh` carries adb (-L to the emulator's adbd on 5555) and the extra ports (-R).
// Metro needs no link: Expo and the React Native CLI run `adb reverse`, which goes through adb.
// The relay cannot carry adb (it only goes from the phone to here), so dev needs gh. See docs/emuly-dev-plan.md.

const sayDev = message => console.error(`emuly dev: ${message}`);
const DEV_FIRST_PORT = 15555; // A local emulator scans 5555-5585. Stay out of that range.

/** Resolves the exit code and all output. Never rejects: a missing file is code -1. */
function run(file, args, ms = 30_000) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] }); } catch { resolve({ code: -1, output: "" }); return; }
    let output = "";
    const timer = setTimeout(() => child.kill(), ms);
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve({ code: -1, output }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, output: output.trim() }); });
  });
}

function devArgs(args) {
  const ports = [];
  let phone, adbPort;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--adb-port" || arg.startsWith("--adb-port=")) {
      const value = arg.includes("=") ? arg.split("=")[1] : args[++index];
      if (!/^\d{1,5}$/.test(value ?? "") || Number(value) < 1024 || Number(value) > 65535) throw new Error("--adb-port is a port from 1024 to 65535.");
      adbPort = Number(value);
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}.`);
    if (!phone) { phone = arg; continue; }
    if (!/^\d{1,5}$/.test(arg) || Number(arg) < 1 || Number(arg) > 65535) throw new Error(`"${arg}" is not a port.`);
    ports.push(Number(arg));
  }
  if (!phone) throw new Error("Usage: emuly dev <phone> [port...] [--adb-port N]");
  return { phone, ports: [...new Set(ports)], adbPort };
}

/** adb on PATH first, then the SDK folders. Undefined when there is none. */
async function findAdb() {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : undefined,
    process.platform === "darwin" ? join(homedir(), "Library", "Android", "sdk") : undefined,
    process.platform === "linux" ? join(homedir(), "Android", "Sdk") : undefined];
  for (const candidate of ["adb", ...roots.filter(Boolean).map(root => join(root, "platform-tools", exe))]) {
    if ((await run(candidate, ["version"], 10_000)).code === 0) return candidate;
  }
  return undefined;
}

/** WSL 2 with a Windows SDK has two adb servers. The IDE sees only one of them. */
async function wslWarning() {
  if (process.platform !== "linux") return;
  let version = "";
  try { version = readFileSync("/proc/version", "utf8"); } catch {}
  if (!/microsoft/i.test(version)) return;
  if ((await run("adb.exe", ["version"], 10_000)).code === 0) {
    sayDev("this is WSL, and Windows has adb too. Run emuly dev on the side whose adb your IDE uses.");
  }
}

const lockPath = phone => join(homedir(), ".config", "emuly", `dev-${phone.replace(/[^\w.-]/g, "_")}.json`);
function readLock(phone) {
  try { const lock = JSON.parse(readFileSync(lockPath(phone), "utf8")); return Number.isInteger(lock.port) && Number.isInteger(lock.pid) ? lock : undefined; }
  catch { return undefined; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function freePort(from) {
  for (let port = from; port < from + 100; port++) if (!await portOpen("127.0.0.1", port)) return port;
  throw new Error(`No free local port from ${from} to ${from + 99}. Use --adb-port.`);
}

async function waitPort(port, alive, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until && alive()) {
    if (await portOpen("127.0.0.1", port)) return true;
    await wait(500);
  }
  return false;
}

/** `adb connect`, then wait for the device state. An unauthorized phone fails at once: a loop cannot fix it. */
async function connectAdb(adb, serial, alive = () => true, ms = 20_000) {
  const until = Date.now() + ms;
  let last = "";
  while (Date.now() < until && alive()) {
    const connected = await run(adb, ["connect", serial], 10_000);
    const state = await run(adb, ["-s", serial, "get-state"], 10_000);
    if (state.code === 0 && state.output === "device") return { ok: true };
    last = `${connected.output} ${state.output}`.trim();
    if (/unauthorized/i.test(last)) return { ok: false, error: "adb_unauthorized", message: "adb says the phone is unauthorized. Restart the phone, then run emuly dev again." };
    await wait(1000);
  }
  return { ok: false, error: "adb_connect_failed",
    message: `adb could not connect to ${serial}${last ? ` (${last.split("\n").pop()})` : ""}. If another adb version runs here, run adb kill-server once, then try again.` };
}

async function devReady(adb, phone, serial, route, ports) {
  const level = Number((await run(adb, ["-s", serial, "shell", "getprop", "ro.build.version.sdk"], 10_000)).output) || undefined;
  if (level && level < 30) sayDev(`the phone is API ${level}. Compose Live Edit needs API 30 or later.`);
  emit({ ok: true, phone, serial, route, ports, api_level: level, env: { ANDROID_SERIAL: serial },
    next: [`flutter run -d ${serial}`, `npx expo run:android --device ${serial}`, `npx react-native run-android --deviceId ${serial}`] });
  sayDev(`adb sees the phone as ${serial}. ${route === "ssh" ? "Keep this running. Ctrl-C disconnects it." : ""}`.trim());
}

async function dev(args) {
  const { phone, ports, adbPort } = devArgs(args);
  const path = `/v1/phones/${encodeURIComponent(phone)}/links`;
  const fail = (error, message) => { emit({ ok: false, error, message }); process.exitCode = 1; };

  const adb = await findAdb();
  if (!adb) return fail("no_adb", "adb is not installed here. It comes with Android platform-tools, the Android SDK, Flutter and Android Studio. Or set ANDROID_HOME.");
  await wslWarning();
  let current;
  try { current = await api("GET", path); } catch (error) { return fail(error.body?.error ?? "dev_failed", error.message); }
  if (!current.codespace_name) return fail("no_codespace", "This phone has no codespace yet.");
  if (!await phoneRunning(phone)) return fail("phone_not_running", "The phone is not running. Start it first.");

  // Inside the phone's own codespace, adb already sees the emulator. No tunnel.
  if (process.env.CODESPACE_NAME === current.codespace_name) {
    const serial = /^(emulator-\d+)\s+device\b/m.exec((await run(adb, ["devices"])).output)?.[1];
    if (!serial) return fail("adb_not_ready", "adb in this codespace does not list the emulator yet. Wait for the boot, then try again.");
    if (ports.length) sayDev("no links are needed here. The app reaches this codespace at 10.0.2.2:<port>.");
    return devReady(adb, phone, serial, "local", []);
  }

  // Another emuly dev already holds the tunnel. Reuse it and exit.
  const lock = readLock(phone);
  if (lock && lock.pid !== process.pid && pidAlive(lock.pid) && await portOpen("127.0.0.1", lock.port)) {
    const serial = `127.0.0.1:${lock.port}`;
    const connected = await connectAdb(adb, serial);
    if (connected.ok) {
      if (ports.length) sayDev(`the running emuly dev (pid ${lock.pid}) owns the tunnel. For more ports, run: emuly link ${phone} ${ports.join(" ")}`);
      return devReady(adb, phone, serial, "shared", []);
    }
  }

  const loginHint = `gh auth login -h github.com -s codespace${current.github_login ? ` (as ${current.github_login})` : ""}`;
  if ((await run("gh", ["--version"], 10_000)).code !== 0) return fail("needs_gh", `emuly dev needs the GitHub CLI. Install gh, then run: ${loginHint}`);
  const ghEnv = await ghEnvFor(current.codespace_name, current.github_login);
  if (!ghEnv) return fail("needs_gh", `No gh account here can open this phone's codespace. Run: ${loginHint}`);

  const local = adbPort ?? await freePort(DEV_FIRST_PORT);
  if (adbPort && await portOpen("127.0.0.1", adbPort)) return fail("port_in_use", `Port ${adbPort} is in use on this computer. Pick another --adb-port.`);
  const serial = `127.0.0.1:${local}`;
  try { mkdirSync(dirname(lockPath(phone)), { recursive: true }); writeFileSync(lockPath(phone), JSON.stringify({ port: local, pid: process.pid })); }
  catch (error) { sayDev(`could not write the lock file: ${error.message}`); }

  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop.abort());
  const targets = new Map(ports.map(port => [port, { host: "127.0.0.1", port }]));
  for (const port of ports) if (!await portOpen("127.0.0.1", port)) sayDev(`nothing listens on port ${port} here yet. Start the server; the link waits for it.`);

  let announced = false, failures = 0;
  const onReady = alive => void (async () => {
    if (!await waitPort(local, alive)) return;
    await run(adb, ["disconnect", serial], 10_000); // An "offline" entry from the last tunnel blocks a new connect.
    const result = await connectAdb(adb, serial, alive);
    if (!alive()) return;
    if (!result.ok) {
      sayDev(result.message);
      if (!announced) { fail(result.error, result.message); stop.abort(); }
      return;
    }
    failures = 0;
    // Announce adb first: the IDE needs only adb. The extra ports are checked after, so a slow runner does not hold up the ready line.
    if (announced) sayDev("reconnected. Flutter lost its debug connection, so run flutter run again. Metro apps reconnect by themselves.");
    else { announced = true; await devReady(adb, phone, serial, "ssh", ports); }
    if (ports.length && !await linkReady(phone, ports, "ssh", alive)) sayDev("adb works, but the runner does not see the extra ports yet.");
  })();

  while (!stop.signal.aborted) {
    let created = !ports.length;
    if (ports.length) {
      try { await api("POST", path, { ports, route: "ssh" }); created = true; }
      catch (error) {
        if ([400, 401, 404, 409].includes(error.status)) { fail(error.body?.error ?? "link_failed", error.message); break; }
        sayDev(`could not create the links: ${error.message}`);
      }
    }
    if (created) {
      try {
        const result = await runSsh(current.codespace_name, targets, onReady, stop.signal, ghEnv, [`127.0.0.1:${local}:127.0.0.1:5555`]);
        if (result === "stopped") break;
      } catch (error) {
        if (stop.signal.aborted) break;
        const detail = (error.stderr ?? "").trim().split("\n").pop();
        sayDev(`${error.message}${detail ? ` ${detail}` : ""}`);
      }
    }
    if (stop.signal.aborted) break;
    if (!await phoneRunning(phone)) {
      sayDev("the phone stopped, so emuly dev ended.");
      if (!announced) fail("phone_not_running", "The phone is not running.");
      break;
    }
    failures++;
    if (!announced && failures >= 3) {
      fail("tunnel_failed", "The tunnel did not start after 3 tries. Read the lines above. The codespace may have no SSH server, or the port may be in use.");
      break;
    }
    await wait(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
  }
  await run(adb, ["disconnect", serial], 10_000);
  for (const port of ports) await api("DELETE", `${path}?port=${port}`).catch(() => {});
  if (readLock(phone)?.pid === process.pid) rmSync(lockPath(phone), { force: true });
}

// The host refuses a request body over 4.5 MB with an HTML page, so /adb takes at most 4 MB of files.
const INLINE_MAX = 4 * 1024 * 1024;
const APP_CHUNK = 4 * 1024 * 1024;
const INSTALL_FLAGS = new Set(["-r", "-t", "-g", "-d"]);

async function emulyFetch(path, init) {
  const response = await fetch(`${emulyBase()}${path}`, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000),
    headers: { authorization: `Bearer ${emulyKey()}`, "x-emuly-client": cliClient(), ...init.headers } });
  let value = {};
  try { value = await response.json(); } catch {}
  if (!response.ok) {
    throw Object.assign(new Error(value.message ?? value.error ?? `Emuly returned ${response.status}.`), { status: response.status, body: value });
  }
  return value;
}

/** One APK through the Apps endpoint: 4 MiB chunks through Emuly, then poll until the install ends. */
async function installByChunks(id, path, bytes, allowDowngrade) {
  const base = `/v1/phones/${id}/app-installs`;
  const json = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let operation = await emulyFetch(base, json({ source: "upload", key: randomUUID(), filename: basename(path), totalBytes: bytes.length, ...(allowDowngrade ? { allowDowngrade: true } : {}) }));
  for (let offset = 0; offset < bytes.length; offset += APP_CHUNK) {
    const chunk = bytes.subarray(offset, offset + APP_CHUNK);
    await emulyFetch(`${base}/${operation.id}/content`, { method: "PUT", body: chunk, headers: { "content-type": "application/octet-stream",
      "x-upload-offset": String(offset), "x-chunk-sha256": createHash("sha256").update(chunk).digest("hex") } });
    console.error(`emuly install: sent ${Math.min(offset + APP_CHUNK, bytes.length)} of ${bytes.length} bytes`);
  }
  operation = await emulyFetch(`${base}/${operation.id}/complete`, { method: "POST" });
  const deadline = Date.now() + 10 * 60_000;
  while (!["succeeded", "failed", "cancelled", "interrupted", "expired"].includes(operation.stage)) {
    if (Date.now() > deadline) throw new Error(`The install is still ${operation.stage}. Poll GET ${base}/${operation.id}.`);
    await wait(2_000);
    operation = await emulyFetch(`${base}/${operation.id}`, { method: "GET" });
  }
  return { route: "app-installs", ...operation, ok: operation.stage === "succeeded" };
}

/**
 * `emuly install <phone> <apk>... [-r] [-t] [-g] [-d]`. The CLI checks the size and picks the route, so an
 * agent never sends a large APK to /adb: at most 4 MB goes to /adb, larger files go to /adb/upload
 * (straight to the phone), and one APK falls back to the Apps endpoint when that direct route fails.
 */
async function install(args) {
  const [phone, ...rest] = args;
  const flags = rest.filter(a => a.startsWith("-")), paths = rest.filter(a => !a.startsWith("-"));
  if (!phone || !paths.length) throw new Error("Usage: emuly install <phone> <apk>... [-r] [-t] [-g] [-d]");
  const unknown = flags.find(flag => !INSTALL_FLAGS.has(flag));
  if (unknown) throw new Error(`Unknown flag ${unknown}. Use -r, -t, -g or -d.`);
  const files = paths.map(path => {
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`No file at ${path}.`);
    return { path, bytes: readFileSync(path) };
  });
  const id = encodeURIComponent(phone);
  // Android needs -r to replace an installed app, and a downgrade (-d) is always a replace.
  const installFlags = [...new Set(["-r", ...flags])];
  const adbArgs = [files.length > 1 ? "install-multiple" : "install", ...installFlags, ...files.map((_, i) => `@file${i}`)];
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  const done = result => { emit(result); if (result.ok === false) process.exitCode = 1; };

  if (total <= INLINE_MAX) {
    const form = new FormData();
    form.set("args", JSON.stringify(adbArgs));
    form.set("timeout_s", "120");
    files.forEach((file, i) => form.set(`file${i}`, new Blob([file.bytes]), basename(file.path)));
    const result = await emulyFetch(`/v1/phones/${id}/adb`, { method: "POST", body: form });
    return done({ route: "adb", ...result, ok: result.exit_code === 0 });
  }

  let ticket;
  try {
    ticket = await emulyFetch(`/v1/phones/${id}/adb/upload`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: adbArgs, timeout_s: 300, files: files.map(file => ({ name: basename(file.path),
        size: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex") })) }) });
  } catch (error) {
    if (error.body?.error !== "direct_upload_unavailable" || files.length > 1) throw error;
    console.error("emuly install: the direct upload is not available. Using the Apps endpoint.");
    return done(await installByChunks(id, files[0].path, files[0].bytes, installFlags.includes("-d")));
  }
  let response;
  try {
    response = await fetch(ticket.url, { method: "PUT", headers: ticket.headers, body: Buffer.concat(files.map(file => file.bytes)),
      signal: AbortSignal.timeout(10 * 60_000) });
  } catch (error) {
    // The PUT never reached the phone (app.github.dev is blocked here, for example), so the ticket was not used.
    if (files.length > 1) throw new Error(`The direct upload to the phone failed: ${error.message}`);
    console.error("emuly install: the phone's direct URL is not reachable. Using the Apps endpoint.");
    return done(await installByChunks(id, files[0].path, files[0].bytes, installFlags.includes("-d")));
  }
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) throw new Error(result.message ?? result.error ?? `The phone returned ${response.status}.`);
  done({ route: "adb/upload", ...result, ok: result.exit_code === 0 });
}

async function unlink(args) {
  const [phone, port] = args;
  if (!phone) throw new Error("Usage: emuly unlink <phone> [port]");
  const query = port ? `?port=${encodeURIComponent(port)}` : "";
  emit(await api("DELETE", `/v1/phones/${encodeURIComponent(phone)}/links${query}`));
}

async function listLinks(args) {
  const [phone] = args;
  if (!phone) throw new Error("Usage: emuly links <phone>");
  emit(await api("GET", `/v1/phones/${encodeURIComponent(phone)}/links`));
}

// ---------------------------------------------------------------------------------------------
// `emuly proxy`: all phone traffic leaves from this computer, or from an upstream proxy here.
// The runner gateway (phone/runner/egress.mjs) sends each phone connection as a CONNECT through a
// link to the small CONNECT server below. Credentials for --via stay in this process: they are
// never sent to Emuly, written to disk, or printed. See docs/phone-proxy-plan.md.

const sayProxy = message => console.error(`emuly proxy: ${message}`);
/** The codespace port of the proxy link. Outside the runner's ports and common dev ports. */
const PROXY_LINK_PORT = 18792;

/** True for loopback, private, link-local, shared, multicast and reserved addresses (v4 and v6). */
function lanAddress(ip) {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (family !== 6) return true;
  const groups = ipv6Groups(ip);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5] = groups;
  // ::/96 (with :: and ::1), ::ffff:0:0/96 and NAT64 64:ff9b::/96 carry an IPv4 address in the last
  // 32 bits, in hex or dotted form. Check that address, so [::ffff:7f00:1] is 127.0.0.1.
  const embedded = () => `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  if (!g0 && !g1 && !g2 && !g3 && !g4 && (g5 === 0 || g5 === 0xffff)) return lanAddress(embedded());
  if (g0 === 0x64 && g1 === 0xff9b && !g2 && !g3 && !g4 && !g5) return lanAddress(embedded());
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00;
}

// The same function is in phone/runner/egress.mjs. lib/emuly-cli-proxy.test.ts checks that the two copies match.
/**
 * The 8 groups of a valid IPv6 address (the caller checks it with isIP), with a dotted IPv4 tail as the last 2.
 * @param {string} ip @returns {number[] | undefined}
 */
function ipv6Groups(ip) {
  let text = ip.toLowerCase().split("%")[0];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - left.length - right.length : 0;
  if (fill < 0) return undefined;
  const groups = [...left, ...Array(fill).fill("0"), ...right].map(group => parseInt(group, 16));
  return groups.length === 8 && groups.every(group => group >= 0 && group <= 0xffff) ? groups : undefined;
}

/** A --via proxy without its user name and password, for messages. */
const viaLabel = via => via ? `${via.protocol}://${via.host.includes(":") ? `[${via.host}]` : via.host}:${via.port}` : "this computer";

/** Parses --via. The error never contains the URL, because it may hold a password. */
function parseVia(text) {
  let url;
  try { url = new URL(text); } catch { throw new Error("--via is http://[user:pass@]host:port or socks5://[user:pass@]host:port."); }
  const protocol = url.protocol.replace(/:$/, "");
  if (!["http", "socks5", "socks5h"].includes(protocol)) throw new Error(`--via does not support ${protocol}://. Use http:// or socks5://.`);
  if (!url.hostname) throw new Error("--via needs a host.");
  const port = Number(url.port || (protocol === "http" ? 8080 : 1080));
  return { protocol, host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port,
    user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) };
}

function proxyArgs(args, env = process.env) {
  const options = { lock: false, allowLan: false, local: false };
  const rest = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--lock") options.lock = true;
    else if (arg === "--allow-lan") options.allowLan = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--via" || arg === "--route") options[arg.slice(2)] = args[++index];
    else if (arg.startsWith("--via=") || arg.startsWith("--route=")) { const [key, value] = arg.slice(2).split(/=(.*)/); options[key] = value; }
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}.`);
    else rest.push(arg);
  }
  const [phone, action = "on", extra] = options.local ? [undefined, "local", rest[0]] : rest;
  if ((!phone && !options.local) || extra || !["on", "off", "status", "local"].includes(action)) {
    throw new Error("Usage: emuly proxy <phone> [--via url] [--lock] [--allow-lan] | emuly proxy <phone> off | emuly proxy <phone> status");
  }
  if (options.route && !["ssh", "relay"].includes(options.route)) throw new Error("--route is ssh or relay.");
  const viaText = options.via ?? env.EMULY_PROXY_VIA;
  return { phone, action, lock: options.lock, allowLan: options.allowLan, route: options.route, via: viaText ? parseVia(viaText) : undefined };
}

/** Reads one HTTP reply head from a socket: the status line and the bytes after the head. */
function readReplyHead(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end >= 0) { cleanup(); resolve({ line: buffer.subarray(0, buffer.indexOf("\r\n")).toString("latin1"), rest: buffer.subarray(end + 4) }); }
      else if (buffer.length > 16_384) { cleanup(); reject(new Error("The upstream proxy sent a bad reply.")); }
    };
    const onEnd = () => { cleanup(); reject(new Error("The upstream proxy closed the connection.")); };
    const cleanup = () => { socket.pause(); socket.off("data", onData); socket.off("end", onEnd); socket.off("error", onEnd); };
    socket.on("data", onData); socket.once("end", onEnd); socket.once("error", onEnd); socket.resume();
  });
}

/** Reads exactly n bytes from a socket (SOCKS5 replies). */
function readBytes(socket, n) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < n) return;
      cleanup();
      if (buffer.length > n) socket.unshift(buffer.subarray(n));
      resolve(buffer.subarray(0, n));
    };
    const onEnd = () => { cleanup(); reject(new Error("The upstream proxy closed the connection.")); };
    const cleanup = () => { socket.pause(); socket.off("data", onData); socket.off("end", onEnd); socket.off("error", onEnd); };
    socket.on("data", onData); socket.once("end", onEnd); socket.once("error", onEnd); socket.resume();
  });
}

function dialTcp(host, port, ms = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, allowHalfOpen: true });
    socket.setNoDelay(true);
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })); }, ms);
    socket.once("connect", () => { clearTimeout(timer); socket.removeAllListeners("error"); resolve(socket); });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
}

function ipv6Bytes(ip) {
  const [left, right = ""] = ip.split("::");
  const parts = text => text ? text.split(":") : [];
  const head = parts(left), tail = parts(right);
  const all = ip.includes("::") ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  return Buffer.from(all.flatMap(part => { const value = parseInt(part, 16); return [value >> 8, value & 0xff]; }));
}

/** Opens a tunnel to host:port through the --via proxy. Errors name the proxy without its password. */
async function viaTunnel(via, host, port) {
  const socket = await dialTcp(via.host, via.port).catch(error => {
    throw Object.assign(new Error(`The upstream proxy ${viaLabel(via)} did not answer (${error.code ?? "error"}).`), { code: "via_unreachable" });
  });
  try {
    if (via.protocol === "http") {
      const name = isIP(host) === 6 ? `[${host}]` : host;
      const auth = via.user || via.pass ? `Proxy-Authorization: Basic ${Buffer.from(`${via.user}:${via.pass}`).toString("base64")}\r\n` : "";
      socket.write(`CONNECT ${name}:${port} HTTP/1.1\r\nHost: ${name}:${port}\r\n${auth}\r\n`);
      const reply = await readReplyHead(socket);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(reply.line)?.[1]);
      if (status === 407) throw Object.assign(new Error(`The upstream proxy ${viaLabel(via)} refused the user name or password.`), { code: "via_auth" });
      if (status !== 200) throw Object.assign(new Error(`The upstream proxy ${viaLabel(via)} refused ${host}:${port} (${status || "bad reply"}).`), { code: "via_refused" });
      if (reply.rest.length) socket.unshift(reply.rest);
      return socket;
    }
    const auth = Boolean(via.user || via.pass);
    socket.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
    const [version, method] = await readBytes(socket, 2);
    if (version !== 5 || method === 0xff || (method === 2 && !auth)) {
      throw Object.assign(new Error(`The upstream proxy ${viaLabel(via)} needs a user name and password.`), { code: "via_auth" });
    }
    if (method === 2) {
      const user = Buffer.from(via.user), pass = Buffer.from(via.pass);
      if (user.length > 255 || pass.length > 255) throw new Error("The --via user name or password is too long.");
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
      const [, ok] = await readBytes(socket, 2);
      if (ok !== 0) throw Object.assign(new Error(`The upstream proxy ${viaLabel(via)} refused the user name or password.`), { code: "via_auth" });
    }
    const family = isIP(host);
    const address = family === 4 ? Buffer.from([1, ...host.split(".").map(Number)])
      : family === 6 ? Buffer.concat([Buffer.from([4]), ipv6Bytes(host)])
      : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)]);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 0xff])]));
    const head = await readBytes(socket, 4);
    if (head[1] !== 0) throw Object.assign(new Error(`The upstream proxy ${viaLabel(via)} refused ${host}:${port} (SOCKS code ${head[1]}).`), { code: "via_refused" });
    const length = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await readBytes(socket, 1))[0];
    await readBytes(socket, length + 2);
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

/**
 * The CONNECT server on 127.0.0.1 that the phone's link reaches. It only takes CONNECT (the
 * runner gateway sends nothing else). Without --allow-lan it refuses this computer's loopback
 * and LAN, so a phone app cannot scan the user's network.
 */
function startLocalProxy({ via, allowLan, lookup = dnsLookup }) {
  const counters = { connections: 0, refused: 0, failed: 0 };
  const server = createNetServer({ allowHalfOpen: true }, client => {
    counters.connections++;
    client.on("error", () => client.destroy());
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => client.destroy(), 10_000);
    const onData = async chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) { if (buffer.length > 16_384) client.destroy(); return; }
      clearTimeout(timer);
      client.off("data", onData);
      client.pause();
      const match = /^CONNECT (\[[0-9a-fA-F:.]+\]|[^\s:]+):(\d{1,5}) HTTP\/1\.[01]\r\n/.exec(buffer.toString("latin1", 0, end + 2));
      const refuse = status => { counters.refused++; client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
      if (!match) return refuse("405 Method Not Allowed");
      const host = match[1].replace(/^\[(.*)\]$/, "$1"), port = Number(match[2]);
      if (port < 1 || port > 65535) return refuse("400 Bad Request");
      let upstream;
      try {
        let target = host;
        if (!allowLan) {
          if (isIP(host)) { if (lanAddress(host)) return refuse("403 Forbidden"); }
          else if (!via) {
            // Connect to the checked address, so a second lookup cannot point the name at the LAN.
            target = await new Promise((resolve, reject) => lookup(host, { family: 0 }, (error, address) => error ? reject(error) : resolve(address)));
            if (lanAddress(target)) return refuse("403 Forbidden");
          }
        }
        upstream = via ? await viaTunnel(via, target, port) : await dialTcp(target, port);
      } catch (error) {
        counters.failed++;
        if (error.code === "via_auth" || error.code === "via_unreachable") sayProxy(error.message);
        return client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
      if (client.destroyed) return upstream.destroy();
      upstream.on("error", () => { upstream.destroy(); client.destroy(); });
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
      client.write("HTTP/1.1 200 Connection established\r\n\r\n");
      const rest = buffer.subarray(end + 4);
      if (rest.length) upstream.write(rest);
      client.pipe(upstream); upstream.pipe(client);
      client.resume();
    };
    client.on("data", onData);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, counters }));
  });
}

async function proxy(args) {
  const options = proxyArgs(args);
  const { phone, action, via } = options;
  if (action === "local") {
    // Only the local CONNECT server, for checks and tests. No link, no Emuly call.
    const local = await startLocalProxy(options);
    emit({ ok: true, local_port: local.port, via: viaLabel(via), lan: options.allowLan ? "allowed" : "blocked" });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { local.server.close(); process.exit(0); });
    return;
  }
  const path = `/v1/phones/${encodeURIComponent(phone)}/proxy`;
  if (action === "status") { emit(await api("GET", path)); return; }
  if (action === "off") { emit(await api("DELETE", path)); return; }

  // Check the upstream proxy first, so a wrong password fails here and not inside the phone.
  if (via) {
    try { (await viaTunnel(via, "1.1.1.1", 443)).destroy(); }
    catch (error) {
      emit({ ok: false, error: error.code ?? "via_failed", message: error.message });
      process.exitCode = 1;
      return;
    }
  }
  const local = await startLocalProxy(options);
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop.abort());
  const targets = new Map([[PROXY_LINK_PORT, { host: "127.0.0.1", port: local.port }]]);
  let on = false;
  const onUp = async route => {
    try {
      await api("POST", path, { mode: "laptop", port: PROXY_LINK_PORT, lock: options.lock });
      on = true;
      const check = await api("POST", `${path}/check`).catch(error => ({ ok: false, error: error.message }));
      const status = await api("GET", path).catch(() => ({}));
      emit({ ok: true, phone, mode: "laptop", route, via: viaLabel(via), exit_ip: check.exit_ip ?? null,
        check: check.ok ? "passed" : check.error ?? "failed", dns: status.dns ?? "unknown", udp: status.udp ?? "unknown",
        lock: options.lock, lan: options.allowLan ? "allowed" : "blocked" });
      sayProxy(`all phone traffic now leaves from ${viaLabel(via)}. Ctrl-C ${options.lock
        ? `keeps the phone offline until: emuly proxy ${phone} off` : "puts the phone back on its own network"}.`);
    } catch (error) {
      emit({ ok: false, error: error.body?.error ?? "proxy_failed", message: error.message });
      process.exitCode = 1;
      stop.abort();
    }
  };
  await holdLink({ phone, ports: [PROXY_LINK_PORT], targets, forced: options.route, stop, onUp });
  local.server.close();
  if (!on) return;
  if (options.lock) { sayProxy(`the phone stays offline (locked). Run: emuly proxy ${phone} off`); return; }
  await api("DELETE", path).then(() => sayProxy("the phone uses its own network again."),
    error => sayProxy(`could not turn the proxy off: ${error.message}. Run: emuly proxy ${phone} off`));
}

const usage = `Usage: emuly <command>

  up      Check gh, migrate the database and start Emuly (--prod adds --production)
  login   Sign in to GitHub through gh's device flow (codespace scope)
  doctor  Check gh, the token, the scope and the database directory
  install emuly install <phone> <apk>... [-r] [-t] [-g] [-d]
          Install APKs. Checks the size and picks the upload route. Prints one line of JSON.
  link    emuly link <phone> <port>... [--to host[:port]] [--route ssh|relay]
          Get this file from your Emuly server: curl -fsSL "$EMULY_BASE_URL/v1/cli" -o emuly.mjs
          Make the phone's localhost:<port> (and 10.0.2.2:<port>) reach <port> on this
          computer, or on --to. Runs until Ctrl-C. Prints one line of JSON when the link works.
  dev     emuly dev <phone> [port...] [--adb-port N]
          Connect the phone to adb here, so flutter run, expo run:android and Android Studio
          see it and hot reload works. Extra ports become links. Needs adb and gh.
          Runs until Ctrl-C. Prints one line of JSON when adb is ready.
  proxy   emuly proxy <phone> [--via url] [--lock] [--allow-lan] [--route ssh|relay]
          Send all phone traffic out from this computer, or from the --via proxy
          (http:// or socks5://, with user:pass@ if needed; or set EMULY_PROXY_VIA).
          The password stays here. This computer's LAN is blocked unless --allow-lan.
          Runs until Ctrl-C, then the phone uses its own network again. With --lock
          the phone stays offline until: emuly proxy <phone> off
          emuly proxy <phone> status | off
  unlink  emuly unlink <phone> [port]   Remove one link, or all links of the phone
  links   emuly links <phone>           List the links of the phone as JSON`;
const commands = { up, login, doctor, install, link, dev, proxy, unlink, links: listLinks };
const [command, ...args] = process.argv.slice(2);
// Help is checked over command and args together, so `emuly --help` exits 0 too.
const wantHelp = [command, ...args].some(a => a === "--help" || a === "-h");
// The agent commands talk to the Emuly server, so each one also checks for a newer CLI in parallel.
const AGENT_COMMANDS = new Set(["install", "link", "dev", "proxy", "unlink", "links"]);
if (!command || !Object.hasOwn(commands, command) || wantHelp) {
  console.log(usage);
  // An unknown command can mean this copy is old. The update makes new commands appear on the next run.
  if (command && !wantHelp && !Object.hasOwn(commands, command)) {
    console.error(`emuly: unknown command ${command}. This copy may be old. Checking the server for a newer emuly.mjs.`);
    await updateCli();
  }
  process.exit(wantHelp ? 0 : 1);
}
const update = AGENT_COMMANDS.has(command) ? updateCli() : Promise.resolve();
await commands[command](args).catch(error => { report(error); process.exitCode = 1; });
await update;
