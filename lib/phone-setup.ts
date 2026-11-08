import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codespaceExec } from "./codespace-tunnel.ts";

/** Files copied into each codespace, relative to `phone/` in this repository. */
const FILES = ["scripts/setup.sh", "scripts/boot.sh", "scripts/stop.sh", "scripts/start-runner.sh", "runner/runner.mjs", "runner/apps.mjs", "runner/apk-download.mjs", "runner/scrcpy.mjs", "runner/scrcpy-protocol.mjs"];

export class PhoneSetupError extends Error {}
export type SetupStatus = "ready" | "working";

/** Runs in the codespace in the background, so no connection stays open while Android installs. */
const RUN = `#!/usr/bin/env bash
builtin cd "$HOME/phonelink"
if bash scripts/setup.sh && bash scripts/start-runner.sh; then
  for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8790/health >/dev/null 2>&1 && exit 0; sleep 1; done
  echo "phonelink: runner did not answer /health"; tail -20 /tmp/runner.log
fi
touch .failed
`;

/**
 * One short check-or-start step. It prints PHONELINK_READY when the runner answers,
 * PHONELINK_WORKING while setup runs (and starts setup when nothing runs), and
 * exits 1 with the log tail after a failed run, which clears the way for a retry.
 */
export function setupScript(root = join(process.cwd(), "phone")) {
  // Windows checkouts and editors can add CRLF; bash on the codespace rejects it.
  const files: [string, string][] = [...FILES.map(file => [file, Buffer.from(readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n")).toString("base64")] as [string, string]),
    ["runner/ws.cjs", readFileSync(join(process.cwd(), "node_modules/next/dist/compiled/ws/index.js")).toString("base64")],
    ["runner/ws.LICENSE", readFileSync(join(process.cwd(), "node_modules/next/dist/compiled/ws/LICENSE")).toString("base64")],
    ["run.sh", Buffer.from(RUN).toString("base64")]];
  const writes = files.map(([file, body]) => `mkdir -p "$(dirname "${file}")"\necho '${body}' | base64 -d > "${file}"`).join("\n");
  // A plain shell, not a login shell: the image's rvm profile fails under bash and kills the run.
  // Node comes from the image's nvm, which the profile would add to PATH.
  return `export PATH="/usr/local/share/nvm/current/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
mkdir -p "$HOME/phonelink" && builtin cd "$HOME/phonelink"
if curl -fsS http://127.0.0.1:8790/health 2>/dev/null | grep -q '"version":4'; then echo PHONELINK_READY; exit 0; fi
if [ -f .failed ]; then rm -f .failed .pid; echo "phonelink setup failed:"; tail -5 setup.log; exit 1; fi
if [ -f .pid ] && kill -0 "$(cat .pid)" 2>/dev/null; then echo PHONELINK_WORKING; exit 0; fi
${writes}
chmod +x scripts/*.sh run.sh
nohup setsid bash run.sh > setup.log 2>&1 < /dev/null &
echo $! > .pid
echo PHONELINK_WORKING
`;
}

/** Checks or starts phone setup over the codespace tunnel, as the phone's owner. Each call takes seconds. */
export function createPhoneSetup({ token, exec = codespaceExec }: {
  token: (userId: number) => Promise<string>;
  exec?: typeof codespaceExec;
}) {
  return async function setupPhone(userId: number, codespaceName: string): Promise<SetupStatus> {
    const secret = await token(userId);
    let result;
    try {
      result = await exec({ token: secret, codespaceName, command: "bash --noprofile --norc -s", stdin: setupScript(), timeoutMs: 90_000 });
    } catch (error) {
      throw new PhoneSetupError(`Could not reach the codespace: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 500));
    }
    const output = result.output.replaceAll(secret, "[redacted]");
    if (result.code === 0 && output.includes("PHONELINK_READY")) return "ready";
    if (result.code === 0 && output.includes("PHONELINK_WORKING")) return "working";
    const last = output.trim().split("\n").filter(Boolean).slice(-3).join(" ");
    throw new PhoneSetupError(`Phone setup failed${last ? `: ${last}` : "."}`.slice(0, 500));
  };
}
