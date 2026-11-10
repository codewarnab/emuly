import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { daemonPolicy, daemonStateDir, findOnPath, forwardHeaders, info, policyJson,
  proxyArguments, proxyEnv, sdkPathEntries } from "../../phone/runner/agent-device-proxy.mjs";

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

test("the proxy gets its own daemon state directory", () => {
  assert.equal(daemonStateDir("/home/ubuntu"), "/home/ubuntu/.emuly-agent-device");
  // The default is our own directory, not the ~/.agent-device every other CLI shares.
  assert.equal(daemonStateDir(), join(homedir(), ".emuly-agent-device"));
});

test("the proxy is spawned with a private state dir and the runner token", () => {
  assert.deepEqual(proxyArguments({ token: "t0ken", stateDir: "/home/ubuntu/.emuly-agent-device" }), [
    "proxy", "--host", "127.0.0.1", "--port", "4310",
    "--state-dir", "/home/ubuntu/.emuly-agent-device", "--daemon-auth-token", "t0ken"]);
});

test("the daemon sees the SDK on PATH, the SDK roots, and no idle reap", () => {
  const env = proxyEnv("/opt/android-sdk", { PATH: "/usr/bin", HOME: "/home/ubuntu" });
  assert.deepEqual(sdkPathEntries("/opt/android-sdk"), ["/opt/android-sdk/platform-tools", "/opt/android-sdk/emulator"]);
  assert.equal(env.PATH, ["/opt/android-sdk/platform-tools", "/opt/android-sdk/emulator", "/usr/bin"].join(delimiter));
  assert.equal(env.ANDROID_HOME, "/opt/android-sdk");
  assert.equal(env.ANDROID_SDK_ROOT, "/opt/android-sdk");
  // 0 disables the detached daemon's idle reap (Agent Device's default is 5 minutes).
  assert.equal(env.AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS, "0");
  assert.equal(env.HOME, "/home/ubuntu", "the rest of the environment is passed through");
  // An empty PATH still yields a PATH that starts with the SDK dirs.
  assert.equal(proxyEnv("/sdk", {}).PATH, ["/sdk/platform-tools", "/sdk/emulator"].join(delimiter));
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
