import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLOSE, PORTS, RESERVED_PORTS, RUNNER_VERSION, runnerHost } from "../phone/runner/contracts.mjs";
import { LOOPBACK_BLOCKED } from "../phone/runner/egress.mjs";
import { RESERVED_PORTS as LINK_RESERVED } from "../phone/runner/links-protocol.mjs";

test("the shell port file matches contracts.mjs", () => {
  const values = Object.fromEntries([...readFileSync("phone/scripts/ports.sh", "utf8").matchAll(/^(\w+)=(\d+)$/gm)].map(m => [m[1], Number(m[2])]));
  assert.deepEqual(values, { EMULATOR_CONSOLE_PORT: PORTS.EMULATOR_CONSOLE, RUNNER_PORT: PORTS.RUNNER, EGRESS_PORT: PORTS.EGRESS,
    EMULATOR_ADB_PORT: PORTS.EMULATOR_ADB });
});

test("links and the egress gateway refuse the same reserved ports", () => {
  assert.equal(LOOPBACK_BLOCKED, RESERVED_PORTS);
  assert.equal(LINK_RESERVED, RESERVED_PORTS);
  assert.deepEqual([...RESERVED_PORTS].sort(), [4310, 5037, 5554, 5555, 8790, 8791, 8792]);
});

test("runnerHost builds the forwarded host and the close codes are distinct", () => {
  assert.equal(runnerHost("cs-1", PORTS.DIRECT), "cs-1-8791.app.github.dev");
  assert.equal(new Set(Object.values(CLOSE)).size, Object.keys(CLOSE).length);
});

test("the runner reports the version that the server expects", () => {
  const runner = readFileSync("phone/runner/runner.mjs", "utf8");
  assert.match(runner, /import \{[^}]*RUNNER_VERSION[^}]*\} from "\.\/contracts\.mjs"/);
  assert.match(runner, /version: RUNNER_VERSION,/);
  assert.ok(Number.isInteger(RUNNER_VERSION));
});
