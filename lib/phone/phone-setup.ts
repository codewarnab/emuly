import "server-only";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { codespaceExec } from "../github/codespace-tunnel.ts";
import { AGENT_DEVICE_VERSION } from "../agent-device-version.ts";
import { collectProgress, measure, progressCursor, diagnosticHealth, diagnosticOperation } from "../diagnostics/diagnostics.ts";
import { validateStep, type Step } from "../diagnostics/diagnostic-contract.ts";

/** Files copied into each codespace, relative to `phone/` in this repository. */
const FILES = ["scripts/progress.sh", "scripts/node-path.sh", "scripts/read-progress.py", "scripts/bounded-log.py", "scripts/setup.sh", "scripts/boot.sh", "scripts/stop.sh", "scripts/start-runner.sh", "scripts/autostart.sh", "runner/runner.mjs", "runner/agent-device-proxy.mjs", "runner/apps.mjs", "runner/apps-protocol.mjs", "runner/adb-protocol.mjs", "runner/apk-download.mjs", "runner/scrcpy.mjs", "runner/scrcpy-protocol.mjs"];

/** The pinned version reaches shell scripts, so refuse anything that is not a plain release version. */
function agentDeviceExport() {
  if (!/^\d+\.\d+\.\d+$/.test(AGENT_DEVICE_VERSION)) throw new Error("Invalid AGENT_DEVICE_VERSION");
  return `export AGENT_DEVICE_VERSION=${AGENT_DEVICE_VERSION}`;
}

/**
 * A short hash of every uploaded file. The runner reports it in /health, so the server can
 * tell that a runner started by autostart.sh runs the scripts of this server version.
 */
export function scriptsVersion(root = join(process.cwd(), "phone")) {
  const hash = createHash("sha256");
  for (const file of FILES) hash.update(file).update("\0").update(readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n"));
  return hash.digest("hex").slice(0, 16);
}

export class PhoneSetupError extends Error {}
export type SetupStatus = "ready" | "working";
export type SetupResult = { state: SetupStatus | "failed"; cursor: number; progress: Step[]; freshness: "observed" | "unavailable" };

/** Runs in the codespace in the background, so no connection stays open while Android installs. */
const RUN = `#!/usr/bin/env bash
builtin cd "$HOME/emuly"
source scripts/progress.sh
# issue #15 P3: warm the emulator while setup runs; POST /boot joins the boot.
if [ -d "$HOME/.android/avd/t.avd" ] && [ -x /opt/android-sdk/emulator/emulator ]; then
  nohup setsid bash scripts/boot.sh cold > early-boot.log 2>&1 < /dev/null &
fi
if bash scripts/setup.sh && bash scripts/start-runner.sh; then
  ph_begin runner_health
  for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8790/health >/dev/null 2>&1 && { ph_end; touch .setup-done; exit 0; }; sleep 1; done
  ph_end failed timeout
fi
touch .failed
`;

/**
 * One short check-or-start step. It prints EMULY_READY when the runner answers,
 * EMULY_WORKING while setup runs (and starts setup when nothing runs), and
 * exits 1 with a fixed failure marker after a failed run, allowing a later retry.
 */
export function setupScript(root = join(process.cwd(), "phone"), cursor = 0) {
  // Windows checkouts and editors can add CRLF; bash on the codespace rejects it.
  const files: [string, string][] = [...FILES.map(file => [file, Buffer.from(readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n")).toString("base64")] as [string, string]),
    ["runner/ws.cjs", readFileSync(join(process.cwd(), "node_modules/next/dist/compiled/ws/index.js")).toString("base64")],
    ["runner/ws.LICENSE", readFileSync(join(process.cwd(), "node_modules/next/dist/compiled/ws/LICENSE")).toString("base64")],
    ["run.sh", Buffer.from(RUN.replace('builtin cd', `export EMULY_DIAGNOSTICS=${diagnosticOperation() ? "1" : "0"}\nexport PH_OPERATION_ID=${diagnosticOperation() ?? "disabled"}\n${agentDeviceExport()}\nbuiltin cd`)).toString("base64")]];
  const writes = files.map(([file, body]) => `mkdir -p "$(dirname "${file}")"\necho '${body}' | base64 -d > "${file}"`);
  writes.push(`echo '${scriptsVersion(root)}' > .scripts-version`);
  // A plain shell, not a login shell: the image's rvm profile fails under bash and kills the run.
  // Node comes from the image's nvm, which the profile would add to PATH.
  return `export PATH="/usr/local/share/nvm/current/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
mkdir -p "$HOME/emuly" && builtin cd "$HOME/emuly"
${diagnosticOperation() ? `if [ -f scripts/read-progress.py ]; then python3 scripts/read-progress.py ${diagnosticOperation()} ${Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0}; fi` : ""}
if curl -fsS http://127.0.0.1:8790/health 2>/dev/null | grep -q '"version":10'; then echo EMULY_READY; exit 0; fi
# A runner from an older build answers health but must be replaced before files are uploaded.
if curl -fsS http://127.0.0.1:8790/health >/dev/null 2>&1; then
  pkill -f "node runner/runner.mjs" 2>/dev/null || true
  if [ -f .pid ]; then kill "$(cat .pid)" 2>/dev/null || true; fi
  rm -f .pid
  for i in $(seq 1 10); do curl -fsS http://127.0.0.1:8790/health >/dev/null 2>&1 || break; sleep 1; done
fi
if [ -f .failed ]; then rm -f .failed .pid; echo EMULY_FAILED; exit 1; fi
# Wait up to 75 s, below the 90 s tunnel timeout, so this call can report readiness.
emuly_wait() {
  [ -f .pid ] && kill -0 "$(cat .pid)" 2>/dev/null || return 0
  for i in $(seq 1 75); do
    if [ -f .failed ]; then rm -f .failed .pid; echo EMULY_FAILED; exit 1; fi
    if curl -fsS http://127.0.0.1:8790/health 2>/dev/null | grep -q '"version":10'; then echo EMULY_READY; exit 0; fi
    kill -0 "$(cat .pid)" 2>/dev/null || return 0
    sleep 1
  done
  echo EMULY_WORKING; exit 0
}
emuly_wait
${writes[0]}
export EMULY_DIAGNOSTICS=${diagnosticOperation() ? "1" : "0"}
export PH_OPERATION_ID=${diagnosticOperation() ?? "disabled"}
${agentDeviceExport()}
source scripts/progress.sh
ph_begin setup_upload
${writes.slice(1).join("\n")}
ph_end
chmod +x scripts/*.sh run.sh
[ ! -f setup.log ] || mv -f setup.log setup.log.previous
ph_begin setup_launch
nohup setsid bash -c 'bash run.sh 2>&1 | python3 scripts/bounded-log.py "$HOME/emuly/setup.log"' >/dev/null 2>&1 < /dev/null &
echo $! > .pid
ph_end
emuly_wait
echo EMULY_WORKING
`;
}

/** Checks or starts phone setup over the codespace tunnel, as the phone's owner. Each call takes seconds. */
export function createPhoneSetup({ token, exec = codespaceExec }: {
  token: (userId: number) => Promise<string>;
  exec?: typeof codespaceExec;
}) {
  async function ingest(output: string): Promise<Omit<SetupResult, "state">> {
    const progress = output.split("\n").find(line => line.startsWith("EMULY_PROGRESS="));
    if (progress) {
      try {
        const batch = JSON.parse(progress.slice("EMULY_PROGRESS=".length));
        await collectProgress(batch);
        if (batch && Number.isSafeInteger(batch.cursor) && batch.cursor >= 0 && batch.cursor <= 1048576
          && Array.isArray(batch.records) && batch.records.length <= 32) return {
          cursor: batch.cursor, progress: batch.records.flatMap((r: unknown) => {
            const record = validateStep(r);
            return record && ["setup", "boot", "runner"].includes(record.producer) ? [record] : [];
          }), freshness: "observed",
        };
      }
      catch { diagnosticHealth.collectorFailures++; }
    } else if (diagnosticOperation()) diagnosticHealth.collectorFailures++;
    return { cursor: await progressCursor(), progress: [], freshness: "unavailable" };
  }
  async function collect(userId: number, codespaceName: string) {
    const operationId = diagnosticOperation();
    if (!operationId || process.env.EMULY_DIAGNOSTICS !== "1") return;
    try {
      const secret = await token(userId);
      const result = await exec({ token: secret, codespaceName, command: "bash --noprofile --norc -s",
        stdin: `python3 "$HOME/emuly/scripts/read-progress.py" ${operationId} ${(await progressCursor())}\n`, timeoutMs: 90000, outputLimit: 32768 });
      await ingest(result.output);
    } catch { diagnosticHealth.collectorFailures++; }
  }
  /**
   * Asks the runner directly through GitHub's port forward, without SSH. True when a runner
   * that autostart.sh started already answers with this server's scripts.
   */
  async function quickCheck(userId: number, codespaceName: string, fetcher: typeof fetch = fetch) {
    if (!/^[\w-]{1,100}$/.test(codespaceName)) return false;
    try {
      const secret = await token(userId);
      const response = await fetcher(`https://${codespaceName}-8790.app.github.dev/health`, { headers: { "X-Github-Token": secret },
        redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) { await response.body?.cancel(); return false; }
      const health = await response.json();
      return health?.ok === true && health.version === 10 && health.scripts === scriptsVersion();
    } catch { return false; }
  }
  return Object.assign(async function setupPhone(userId: number, codespaceName: string): Promise<SetupResult> {
    const secret = await measure("credential_lookup", () => token(userId));
    let result;
    try {
      result = await exec({ token: secret, codespaceName, command: "bash --noprofile --norc -s", stdin: setupScript(undefined, await progressCursor()), timeoutMs: 90_000, outputLimit: 32768 });
    } catch (error) {
      throw new PhoneSetupError("Could not reach the codespace. Emuly will retry setup.");
    }
    const output = result.output.replaceAll(secret, "[redacted]");
    const progress = await ingest(output);
    if (result.code === 0 && output.includes("EMULY_READY")) return { state: "ready", ...progress };
    if (result.code === 0 && output.includes("EMULY_WORKING")) return { state: "working", ...progress };
    return { state: "failed", ...progress };
  }, { collect, quickCheck });
}
