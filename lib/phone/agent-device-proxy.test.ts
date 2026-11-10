import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonPolicy, findOnPath, forwardHeaders, info, policyJson } from "../../phone/runner/agent-device-proxy.mjs";

test("the daemon policy allows one emulator and denies device lifecycle commands", () => {
  assert.deepEqual(JSON.parse(policyJson()), {
    version: 1,
    devices: { allow: [{ serial: "emulator-5554" }] },
    commands: { deny: ["boot", "shutdown"] },
    capabilities: { deny: ["device-shutdown"] },
  });
  assert.deepEqual(daemonPolicy("other-serial").devices.allow, [{ serial: "other-serial" }]);
  // The daemon accepts only its own keys: anything extra rejects the file at startup.
  assert.deepEqual(Object.keys(daemonPolicy()).sort(), ["capabilities", "commands", "devices", "version"]);
});

test("forwarding drops hop-by-hop and runner-credential headers but keeps message headers", () => {
  assert.deepEqual(forwardHeaders({
    host: "127.0.0.1:8790", connection: "keep-alive", "keep-alive": "timeout=5", "transfer-encoding": "chunked",
    upgrade: "h2c", te: "trailers", trailer: "x-checksum", "proxy-authorization": "secret", "proxy-connection": "keep-alive",
    "x-phone-secret": "runner-secret", "content-type": "application/json", "content-length": "42",
    authorization: "Bearer client-token", "x-request-id": "abc",
  }), { "content-type": "application/json", "content-length": "42", authorization: "Bearer client-token", "x-request-id": "abc" });
});

test("the proxy reports disabled before it is started", () => {
  const state = info();
  assert.equal(state.ready, false);
  assert.equal(state.token, null);
  assert.equal(state.version, process.env.AGENT_DEVICE_VERSION?.trim() || null);
});

test("PATH lookup finds only executable files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-device-path-"));
  try {
    assert.equal(findOnPath("agent-device", root), null);
    const binary = join(root, "agent-device");
    await writeFile(binary, "#!/bin/sh\nexit 0\n");
    assert.equal(findOnPath("agent-device", root), null, "a non-executable file is not a command");
    await chmod(binary, 0o755);
    assert.equal(findOnPath("agent-device", `${join(root, "missing")}:${root}`), binary);
  } finally { await rm(root, { recursive: true, force: true }); }
});
