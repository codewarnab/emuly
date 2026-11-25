import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME, LinkError, linkPorts, parseTarget } from "./phone-links-contract.ts";
import { LOCAL_SERVER_URL, decodeFrame, encodeFrame, listeningPorts, localServerUrls, logcatHints, netCheckResult } from "../../phone/runner/links-protocol.mjs";
import { classifyTarget, netCheckFix } from "./net-check.ts";
import { createPhoneLinksApi } from "./phone-links-api.ts";

test("link ports reject reserved, low, duplicate and too many ports", () => {
  assert.deepEqual(linkPorts([3000, "8081"]), [3000, 8081]);
  for (const bad of [[], [80], [8790], [5037], [3000, 3000], [0], ["3000x"], Array.from({ length: 9 }, (_, i) => 3000 + i)]) {
    assert.throws(() => linkPorts(bad), LinkError, JSON.stringify(bad));
  }
});

test("targets accept host:port, IPv6 and URLs, and refuse shell text", () => {
  assert.deepEqual(parseTarget("localhost:3000"), { host: "localhost", port: 3000 });
  assert.deepEqual(parseTarget("[::1]:8080"), { host: "::1", port: 8080 });
  assert.deepEqual(parseTarget("https://api.example.com/v1"), { host: "api.example.com", port: 443 });
  for (const bad of ["localhost", "a;rm -rf /:80", "$(id):80", "host:99999", "a b:80"]) assert.throws(() => parseTarget(bad), LinkError, bad);
});

test("relay frames round-trip", () => {
  assert.deepEqual(decodeFrame(encodeFrame(FRAME.OPEN, 7, 3000)), { type: FRAME.OPEN, id: 7, port: 3000 });
  const data = decodeFrame(encodeFrame(FRAME.DATA, 0xfffffffe, Buffer.from("hi")));
  assert.equal(data?.type, FRAME.DATA);
  assert.equal(data?.id, 0xfffffffe);
  assert.equal((data as { data: Buffer }).data.toString(), "hi");
  assert.deepEqual(decodeFrame(encodeFrame(FRAME.CLOSE, 1)), { type: FRAME.CLOSE, id: 1 });
  assert.equal(decodeFrame(Buffer.from([9, 0, 0, 0, 1])), undefined);
  assert.equal(decodeFrame(Buffer.from([1, 0])), undefined);
});

test("listening ports come from LISTEN rows of /proc/net/tcp only", () => {
  const text = `  sl  local_address rem_address   st
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000
   1: 0100007F:1F90 0100007F:D2F0 01 00000000:00000000`;
  assert.deepEqual([...listeningPorts(text)], [3000]);
});

test("logcat hints name the target and the kind of failure, newest last, once each", () => {
  const hints = logcatHints([
    "E/okhttp ( 123): java.net.ConnectException: Failed to connect to localhost/127.0.0.1:3000",
    "W/System.err( 1): java.net.UnknownHostException: Unable to resolve host \"api.lan\": No address",
    "E/okhttp ( 123): java.net.ConnectException: Failed to connect to localhost/127.0.0.1:3000",
    "I/other: nothing here",
    "E/adbd    (  536): failed to connect to socket 'localabstract:scrcpy_7ef1f72c': could not connect",
    "E/SystemServiceRegistry(  671): android.os.ServiceManager$ServiceNotFoundException: No service published for: face",
    "W/resolv  (  460): SSL_connect ssl error =5, mark 0xf0065: Connection refused",
    "E/NetworkSecurityConfig: CLEARTEXT communication to 10.0.2.2 not permitted by network security policy",
  ].join("\n"));
  assert.deepEqual(hints.map(hint => hint.kind), ["dns", "refused", "cleartext"]);
  assert.equal(hints[1]!.target, "localhost:3000");
  assert.equal(logcatHints("E/x: Failed to connect to /10.0.2.2 (port 3000) from /10.0.2.16 (port 4000)")[0]!.target, "10.0.2.2:3000");
});

test("net-check needs a reply: a link tunnel that closes with no reply is not reachable", () => {
  assert.deepEqual(netCheckResult("exit=0\nbytes=17\n"), { reachable: true, detail: "" });
  assert.deepEqual(netCheckResult("exit=124\nbytes=0\n"), { reachable: true, detail: "" }, "open and silent");
  const closed = netCheckResult("exit=0\nbytes=0\n");
  assert.equal(closed.reachable, false);
  assert.match(closed.detail, /nothing listens/);
  assert.deepEqual(netCheckResult("exit=1\nbytes=0\nnc: connect: Connection refused"),
    { reachable: false, detail: "nc: connect: Connection refused" });
  assert.equal(netCheckResult("").reachable, false);
});

test("an APK scan keeps local server URLs only, with default ports", () => {
  const bundle = 'fetch("http://localhost:3000/api");ws="wss://devbox.tail1234.ts.net";x="https://api.example.com";'
    + 'y="http://192.168.1.20:8080/v1";z="http://10.0.2.2:8081";n="http://100.101.102.103:4000";';
  const grep = [...bundle.matchAll(new RegExp(LOCAL_SERVER_URL, "g"))].map(match => match[0]).join("\n");
  assert.deepEqual(localServerUrls(`${grep}\nhttp://localhost:3000\nhttp://localhost:99999`), [
    { url: "http://localhost:3000", host: "localhost", port: 3000 },
    { url: "wss://devbox.tail1234.ts.net", host: "devbox.tail1234.ts.net", port: 443 },
    { url: "http://192.168.1.20:8080", host: "192.168.1.20", port: 8080 },
    { url: "http://10.0.2.2:8081", host: "10.0.2.2", port: 8081 },
    { url: "http://100.101.102.103:4000", host: "100.101.102.103", port: 4000 },
  ]);
});

test("address classes and fixes", () => {
  assert.equal(classifyTarget("localhost"), "laptop-loopback");
  assert.equal(classifyTarget("127.0.0.1"), "laptop-loopback");
  assert.equal(classifyTarget("10.0.2.2"), "codespace-host");
  assert.equal(classifyTarget("192.168.1.20"), "private-lan");
  assert.equal(classifyTarget("172.20.0.5"), "private-lan");
  assert.equal(classifyTarget("devbox.local"), "private-lan");
  assert.equal(classifyTarget("my-vm.tail1234.ts.net"), "tailscale");
  assert.equal(classifyTarget("100.101.102.103"), "tailscale");
  assert.equal(classifyTarget("api.example.com"), "public");
  assert.equal(netCheckFix({ host: "localhost", port: 3000 }, "laptop-loopback", false, "p1"), "emuly link p1 3000");
  assert.match(netCheckFix({ host: "192.168.1.20", port: 8080 }, "private-lan", false, "p1")!, /emuly link p1 8080 --to 192\.168\.1\.20:8080/);
  assert.equal(netCheckFix({ host: "localhost", port: 3000 }, "laptop-loopback", true), undefined);
  // A port with a working link needs the laptop server, not another link.
  const linked = netCheckFix({ host: "localhost", port: 8081 }, "laptop-loopback", false, "p1", true)!;
  assert.match(linked, /Start the server on the laptop on port 8081/);
  assert.doesNotMatch(linked, /emuly link/);
});

const running = { id: "p1", state: "running", android_state: "ready" };
function api(overrides: Partial<Parameters<typeof createPhoneLinksApi>[0]> = {}) {
  const calls: unknown[] = [];
  const links = createPhoneLinksApi({
    user: async () => ({ id: 7, authKind: "agent" }),
    phone: async (_, id) => id === "p1" ? running : undefined,
    runner: async (userId, id, path, body) => {
      calls.push({ userId, id, path, body });
      if (path === "/net-check") return { codespaceName: "cs-1", response: Response.json({ reachable: false, detail: "Connection refused", logcat: [] }) };
      if (path === "/links/remove") return { codespaceName: "cs-1", response: Response.json({ links: [] }) };
      return { codespaceName: "cs-1", response: Response.json({ links: [{ port: 3000, route: "ssh", listening: false }] }) };
    },
    issue: async () => "t".repeat(43),
    baseUrl: () => "https://emuly.test",
    ...overrides,
  });
  return { links, calls };
}
const post = (body: unknown, headers: Record<string, string> = {}) => new Request("https://emuly.test/v1/phones/p1/links",
  { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("create checks input before the runner, and gives the ssh command or a relay ticket", async () => {
  const { links, calls } = api();
  assert.equal((await links.create(post({ ports: [8790] }), "p1")).status, 400);
  assert.equal((await links.create(post({ ports: [3000], route: "ftp" }), "p1")).status, 400);
  assert.deepEqual(calls, []);

  const ssh = await links.create(post({ ports: [3000] }), "p1");
  assert.equal(ssh.status, 201);
  const sshBody = await ssh.json();
  assert.equal(sshBody.codespace_name, "cs-1");
  assert.deepEqual(sshBody.ssh.slice(-2), ["-R", "3000:127.0.0.1:3000"]);
  assert.equal(sshBody.ticket, undefined);

  const relay = await (await links.create(post({ ports: [3000], route: "relay" }), "p1")).json();
  assert.equal(relay.ticket.length, 43);
  assert.equal(relay.relay_url, "wss://emuly.test/v1/phones/p1/links/relay");
  assert.deepEqual(calls.at(-1), { userId: 7, id: "p1", path: "/links", body: { ports: [3000], route: "relay" } });
});

test("links need a running phone owned by the caller, and a cookie request needs its origin", async () => {
  assert.equal((await api({ user: async () => null }).links.list(new Request("https://emuly.test/x"), "p1")).status, 401);
  assert.equal((await api().links.list(new Request("https://emuly.test/x"), "other")).status, 404);
  const stopped = api({ phone: async () => ({ id: "p1", state: "stopped", android_state: "off" }) });
  assert.equal((await stopped.links.create(post({ ports: [3000] }), "p1")).status, 409);
  const cookie = api({ user: async () => ({ id: 7, authKind: "session" }) });
  assert.equal((await cookie.links.create(post({ ports: [3000] }), "p1")).status, 403);
  assert.deepEqual(cookie.calls, []);
});

test("net-check classifies the target and gives the fix", async () => {
  const { links, calls } = api();
  const response = await links.netCheck(new Request("https://emuly.test/v1/phones/p1/net-check?target=localhost:3000"), "p1");
  assert.deepEqual(await response.json(), { target: "localhost:3000", reachable: false, class: "laptop-loopback",
    fix: "emuly link p1 3000", detail: "Connection refused", logcat: [] });
  assert.deepEqual(calls, [{ userId: 7, id: "p1", path: "/net-check", body: { host: "localhost", port: 3000 } },
    { userId: 7, id: "p1", path: "/links", body: undefined }]);
  assert.equal((await links.netCheck(new Request("https://emuly.test/x?target=$(id):1"), "p1")).status, 400);

  // The port has a live tunnel: the fix asks for the laptop server, not a new link.
  const tunnel = api({ runner: async (_userId, _id, path) => ({ codespaceName: "cs-1", response: Response.json(path === "/net-check"
    ? { reachable: false, logcat: [] } : { links: [{ port: 3000, route: "ssh", listening: true }] }) }) });
  const linked = await (await tunnel.links.netCheck(new Request("https://emuly.test/x?target=localhost:3000"), "p1")).json();
  assert.equal(linked.linked, true);
  assert.match(linked.fix, /Start the server on the laptop on port 3000/);
});

test("remove sends one port or all", async () => {
  const { links, calls } = api();
  await links.remove(new Request("https://emuly.test/v1/phones/p1/links?port=3000", { method: "DELETE" }), "p1");
  await links.remove(new Request("https://emuly.test/v1/phones/p1/links", { method: "DELETE" }), "p1");
  assert.deepEqual(calls.map(call => (call as { body: unknown }).body), [{ port: 3000 }, {}]);
});

test("proxy: input is checked before the runner, off is direct, and an old runner asks for an update", async () => {
  const { links, calls } = api();
  const proxyPost = (body: unknown) => new Request("https://emuly.test/v1/phones/p1/proxy",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const body of [{ mode: "vpn" }, { mode: "laptop" }, { mode: "laptop", port: 8790 }, { mode: "laptop", port: "18792" }]) {
    assert.equal((await links.proxySet(proxyPost(body), "p1")).status, 400, JSON.stringify(body));
  }
  assert.equal((await links.proxySet(new Request("https://emuly.test/v1/phones/p1/proxy", { method: "POST", body: "nope" }), "p1")).status, 400);
  assert.deepEqual(calls, []);

  assert.equal((await links.proxySet(proxyPost({ mode: "laptop", port: 18792, lock: true, via: "http://me:pw@x" }), "p1")).status, 200);
  assert.deepEqual(calls.at(-1), { userId: 7, id: "p1", path: "/egress", body: { mode: "laptop", port: 18792, lock: true } });
  assert.equal((await links.proxyOff(new Request("https://emuly.test/v1/phones/p1/proxy", { method: "DELETE" }), "p1")).status, 200);
  assert.deepEqual((calls.at(-1) as unknown as { body?: unknown }).body, { mode: "direct" });
  await links.proxyCheck(new Request("https://emuly.test/v1/phones/p1/proxy/check", { method: "POST" }), "p1");
  assert.equal((calls.at(-1) as unknown as { path?: string }).path, "/egress/check");
  assert.equal((await links.proxyStatus(new Request("https://emuly.test/v1/phones/p1/proxy"), "nope")).status, 404);

  const old = api({ runner: async () => ({ codespaceName: "cs-1", response: Response.json({ error: "not found" }, { status: 404 }) }) });
  const reply = await old.links.proxyStatus(new Request("https://emuly.test/v1/phones/p1/proxy"), "p1");
  assert.equal(reply.status, 503);
  assert.equal((await reply.json() as { error: string }).error, "runner_update_required");
});
