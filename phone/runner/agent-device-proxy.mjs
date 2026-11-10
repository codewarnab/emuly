// A supervised `agent-device proxy` beside the runner, reachable only through the runner.
//
// The proxy listens on loopback and serves the daemon contract under /agent-device/*.
// The runner forwards those paths to it, so the tunnel that already reaches 8790 can
// carry agent-device traffic without exposing a second port. The token is minted here
// and handed out only by GET /agent-device-info, which sits behind the runner secret.
//
// No tokens are logged: the CLI prints its own token to stdout, so the log file is
// opened 0600 and the token never touches the runner's output.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const PROXY_HOST = "127.0.0.1"; // the CLI's default, pinned so the forward target is known
const PROXY_PORT = 4310;
const HEALTH_PATH = "/agent-device/health";
const PATH_PREFIX = "/agent-device/";
const POLICY_SERIAL = "emulator-5554";
const LOG_PATH = "/tmp/agent-device-proxy.log";
const HEALTH_INTERVAL_MS = 10_000;
const HEALTH_TIMEOUT_MS = 2_000;
const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 30_000;

// Hop-by-hop headers describe one connection, never the forwarded message. `host` is
// rebuilt by the client and `x-phone-secret` is the runner's own credential, so neither
// may reach the proxy or its logs.
const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "x-phone-secret"]);

/** The daemon policy: one emulator, no device lifecycle, no shutdown capability. */
export function daemonPolicy(serial = POLICY_SERIAL) {
  return { version: 1, devices: { allow: [{ serial }] }, commands: { deny: ["boot", "shutdown"] },
    capabilities: { deny: ["device-shutdown"] } };
}

export function policyJson(serial = POLICY_SERIAL) {
  return JSON.stringify(daemonPolicy(serial));
}

/** Headers safe to replay on the proxied request or response. */
export function forwardHeaders(headers) {
  const kept = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || key.startsWith("proxy-") || value === undefined) continue;
    kept[key] = value;
  }
  return kept;
}

/** First executable named `name` on `path`, or null. No shell, no subprocess. */
export function findOnPath(name, path = process.env.PATH ?? "") {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; }
    catch { /* not here */ }
  }
  return null;
}

const state = { binary: null, policyPath: null, child: null, token: null, healthy: false,
  restarts: 0, health: null, retry: null, logFd: null, stopped: false };

function version() {
  const pinned = process.env.AGENT_DEVICE_VERSION?.trim();
  return pinned ? pinned : null;
}

function send(res, status, value) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

/** Probes the local proxy. An explicit token is not needed: health is unauthenticated. */
function probe() {
  if (!state.child) { state.healthy = false; return; }
  const req = request({ host: PROXY_HOST, port: PROXY_PORT, path: HEALTH_PATH, method: "GET",
    headers: { accept: "application/json" }, timeout: HEALTH_TIMEOUT_MS }, res => {
    res.resume();
    res.on("end", () => {
      state.healthy = res.statusCode === 200;
      if (state.healthy) state.restarts = 0;
    });
  });
  req.on("timeout", () => req.destroy());
  req.on("error", () => { state.healthy = false; });
  req.end();
}

function scheduleRestart() {
  if (state.stopped || !state.binary || state.retry) return;
  const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** state.restarts);
  state.restarts += 1;
  state.retry = setTimeout(() => { state.retry = null; launch(); }, delay);
  state.retry.unref?.();
}

function launch() {
  if (state.stopped || !state.binary) return;
  const token = randomBytes(32).toString("base64url");
  // The CLI only accepts its auth token as a flag, so it is visible in this process's
  // argv; the runner never prints it and the policy file holds no secret.
  const child = spawn(state.binary, ["proxy", "--host", PROXY_HOST, "--port", String(PROXY_PORT),
    "--daemon-auth-token", token], {
    env: { ...process.env, AGENT_DEVICE_DAEMON_POLICY: state.policyPath }, stdio: ["ignore", state.logFd, state.logFd],
  });
  state.child = child;
  state.token = token;
  state.healthy = false;
  child.on("error", () => { if (state.child === child) { state.child = null; state.healthy = false; } scheduleRestart(); });
  child.on("exit", () => {
    if (state.child === child) { state.child = null; state.token = null; }
    state.healthy = false;
    scheduleRestart();
  });
  console.log(`agent-device proxy: started (pid ${child.pid ?? "unknown"}, log ${LOG_PATH})`);
  // Probe once the process has had a moment to bind; the interval covers the rest.
  const first = setTimeout(probe, 1_000);
  first.unref?.();
}

function stop() {
  state.stopped = true;
  state.healthy = false;
  if (state.health) clearInterval(state.health);
  if (state.retry) clearTimeout(state.retry);
  state.health = state.retry = null;
  const child = state.child;
  state.child = null;
  state.token = null;
  if (child && child.exitCode === null) { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
  if (state.logFd !== null) { try { closeSync(state.logFd); } catch { /* already closed */ } state.logFd = null; }
}

/** Creates the 0700 policy directory once; the daemon reads the file at start. */
function writePolicy() {
  const directory = mkdtempSync(join(tmpdir(), "emuly-agent-device-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "policy.json");
  writeFileSync(path, policyJson(), { mode: 0o600 });
  return path;
}

function openLog() {
  let fd;
  try { fd = openSync(LOG_PATH, "a", 0o600); chmodSync(LOG_PATH, 0o600); }
  catch { return null; }
  return fd;
}

const controller = { start: startAgentDeviceProxy, stop, info, forward };
let started = false;

/** Starts the supervised proxy once; a second call returns the running controller. */
export function startAgentDeviceProxy() {
  if (started) return controller;
  started = true;
  state.binary = findOnPath("agent-device");
  if (!state.binary) {
    console.log("agent-device proxy: disabled, agent-device is not on PATH");
    return controller;
  }
  try {
    state.policyPath = writePolicy();
    state.logFd = openLog();
  } catch (error) {
    console.log(`agent-device proxy: disabled, could not prepare policy (${error?.message ?? error})`);
    state.stopped = true;
    return controller;
  }
  if (state.logFd === null) {
    console.log("agent-device proxy: disabled, log file is unavailable");
    state.stopped = true;
    return controller;
  }
  process.once("exit", stop);
  process.once("SIGTERM", () => { stop(); process.exit(143); });
  process.once("SIGINT", () => { stop(); process.exit(130); });
  launch();
  state.health = setInterval(probe, HEALTH_INTERVAL_MS);
  state.health.unref?.();
  return controller;
}

/** Proxy state for the runner's info route. The token is null whenever no child is alive. */
export function info() {
  return { ready: Boolean(state.child && state.healthy), token: state.child ? state.token : null, version: version() };
}

/** Streams one /agent-device/* request to the local proxy, both bodies unbuffered. */
export function forward(req, res) {
  if (!info().ready) return send(res, 503, { error: "agent-device is not ready." });
  const upstream = request({ host: PROXY_HOST, port: PROXY_PORT, path: req.url ?? PATH_PREFIX, method: req.method,
    headers: forwardHeaders(req.headers) }, reply => {
    if (res.destroyed) { reply.destroy(); return; }
    res.writeHead(reply.statusCode ?? 502, forwardHeaders(reply.headers));
    reply.on("error", () => res.destroy());
    reply.pipe(res);
  });
  upstream.on("error", () => send(res, 502, { error: "agent-device proxy is unavailable." }));
  req.on("error", () => upstream.destroy());
  req.pipe(upstream);
}
