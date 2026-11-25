#!/usr/bin/env node
// Emuly CLI: `emuly up|login|doctor|install|link|dev|unlink|links`. Plain Node, no dependencies. Used on the host
// (`pnpm emuly up`) and as the container command (`node bin/emuly.mjs up --prod --no-browser`).
// All interactive child output is inherited, so the user sees gh's device-flow code and the
// server log. Checks run with piped output so their stderr can be shown on failure.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
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
    headers: { authorization: `Bearer ${emulyKey()}`, ...(body ? { "content-type": "application/json" } : {}) },
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
async function updateCli() {
  const self = fileURLToPath(import.meta.url);
  const url = `${emulyBase()}/v1/cli`;
  const manual = `the server has a newer emuly.mjs. Get it with: curl -fsSL ${url} -o "${self}"`;
  try {
    const mine = sha256(readFileSync(self, "utf8").split(String.fromCharCode(13)).join(""));
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5_000) });
    const theirs = response.headers.get("x-emuly-cli-sha256");
    if (!response.ok || !theirs || theirs === mine) return;
  } catch { return; }
  if (process.env.EMULY_CLI_AUTO_UPDATE === "0" || existsSync(join(dirname(self), "..", ".git"))) { say(manual); return; }
  const temporary = `${self}.${process.pid}.tmp`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await response.text();
    const sent = response.headers.get("x-emuly-cli-sha256");
    if (!response.ok || !sent || sha256(body) !== sent) {
      say(`the new emuly.mjs did not match its SHA-256, so this copy stays. ${manual}`);
      return;
    }
    writeFileSync(temporary, body);
    renameSync(temporary, self);
    say("updated emuly.mjs from the server. The new copy runs from the next command.");
  } catch {
    rmSync(temporary, { force: true });
    say(manual);
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
      reject(Object.assign(new Error(FATAL_CLOSE.get(event.code) ?? (open ? `The relay closed (${event.code}).` : "The relay could not connect.")),
        { fatal: FATAL_CLOSE.has(event.code), code: event.code }));
    });
  });
}

async function link(args) {
  const { phone, ports, targets, route: forced } = linkArgs(args);
  const path = `/v1/phones/${encodeURIComponent(phone)}/links`;
  const stop = new AbortController();
  // Ctrl-C removes the links on the phone, so no stale adb reverse rule stays behind.
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop.abort());

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
  void updateCli();
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
  void updateCli();

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
    headers: { authorization: `Bearer ${emulyKey()}`, ...init.headers } });
  let value = {};
  try { value = await response.json(); } catch {}
  if (!response.ok) {
    throw Object.assign(new Error(value.message ?? value.error ?? `Emuly returned ${response.status}.`), { status: response.status, body: value });
  }
  return value;
}

/** One APK through the Apps endpoint: 4 MiB chunks through Emuly, then poll until the install ends. */
async function installByChunks(id, path, bytes) {
  const base = `/v1/phones/${id}/app-installs`;
  const json = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let operation = await emulyFetch(base, json({ source: "upload", key: randomUUID(), filename: basename(path), totalBytes: bytes.length }));
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
  const installFlags = flags.length ? [...new Set(flags)] : ["-r"];
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
    return done(await installByChunks(id, files[0].path, files[0].bytes));
  }
  let response;
  try {
    response = await fetch(ticket.url, { method: "PUT", headers: ticket.headers, body: Buffer.concat(files.map(file => file.bytes)),
      signal: AbortSignal.timeout(10 * 60_000) });
  } catch (error) {
    // The PUT never reached the phone (app.github.dev is blocked here, for example), so the ticket was not used.
    if (files.length > 1) throw new Error(`The direct upload to the phone failed: ${error.message}`);
    console.error("emuly install: the phone's direct URL is not reachable. Using the Apps endpoint.");
    return done(await installByChunks(id, files[0].path, files[0].bytes));
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
  unlink  emuly unlink <phone> [port]   Remove one link, or all links of the phone
  links   emuly links <phone>           List the links of the phone as JSON`;
const commands = { up, login, doctor, install, link, dev, unlink, links: listLinks };
const [command, ...args] = process.argv.slice(2);
// Help is checked over command and args together, so `emuly --help` exits 0 too.
const wantHelp = [command, ...args].some(a => a === "--help" || a === "-h");
if (!command || !Object.hasOwn(commands, command) || wantHelp) {
  console.log(usage);
  process.exit(wantHelp ? 0 : 1);
}
await commands[command](args).catch(error => { report(error); process.exitCode = 1; });
