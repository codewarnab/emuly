#!/usr/bin/env node
// Emuly CLI: `emuly up|login|doctor`. Plain Node, no dependencies. Used on the host
// (`pnpm emuly up`) and as the container command (`node emuly.mjs up --prod --no-browser`).
// All interactive child output is inherited, so the user sees gh's device-flow code and the
// server log. Checks run with piped output so their stderr can be shown on failure.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
      writeFileSync(join(dir, "base-url"), `${url}\n`);
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
  const child = spawn("node", ["server.mjs", ...(args.includes("--prod") ? ["--production"] : [])],
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

const usage = `Usage: emuly <command>

  up      Check gh, migrate the database and start Emuly (--prod adds --production)
  login   Sign in to GitHub through gh's device flow (codespace scope)
  doctor  Check gh, the token, the scope and the database directory`;
const [command, ...args] = process.argv.slice(2);
// Help is checked over command and args together, so `emuly --help` exits 0 too.
const wantHelp = [command, ...args].some(a => a === "--help" || a === "-h");
if (!command || !{ up, login, doctor }[command] || wantHelp) {
  console.log(usage);
  process.exit(wantHelp ? 0 : 1);
}
await { up, login, doctor }[command](args).catch(error => { report(error); process.exitCode = 1; });
