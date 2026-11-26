import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect, type Server } from "node:net";

const cli = resolve("bin/emuly.mjs");
const SECRET = "s3cret-Pa55";
const env = { ...process.env, EMULY_CLI_AUTO_UPDATE: "0", EMULY_KEY: "test", EMULY_PROXY_VIA: "" };
const listen = (server: Server) => new Promise<number>(done => server.listen(0, "127.0.0.1", () => done((server.address() as any).port)));

/** Starts `emuly proxy --local ...` and resolves its JSON line and the child. */
async function localProxy(args: string[]) {
  const child = spawn(process.execPath, [cli, "proxy", "--local", ...args], { env });
  let stdout = "", stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const line = await new Promise<any>((done, fail) => {
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("\n")) done(JSON.parse(stdout.split("\n")[0])); });
    child.on("close", code => fail(new Error(`exit ${code}: ${stderr}`)));
  });
  return { child, line, output: () => stdout + stderr };
}

/** One CONNECT through the local proxy. Sends `body` after a 200, half-closes, and returns all bytes. */
function connectThrough(port: number, target: string, body = "ping") {
  return new Promise<string>(done => {
    const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    let out = "", sent = false;
    socket.on("data", (chunk: Buffer) => { out += chunk; if (!sent && out.includes("\r\n\r\n") && out.startsWith("HTTP/1.1 200")) { sent = true; socket.end(body); } });
    socket.on("end", () => socket.end());
    socket.on("close", () => done(out));
    socket.on("error", () => {});
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
}

async function echo() {
  const server = createServer({ allowHalfOpen: true }, socket => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => socket.end(Buffer.concat([Buffer.from("echo:"), ...chunks])));
  });
  return { server, port: await listen(server) };
}

/** Runs the CLI to the end without blocking this process, so the fake servers here can answer. */
function runCli(args: string[], extra: Record<string, string>) {
  return new Promise<{ status: number | null, stdout: string, stderr: string }>(done => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...env, ...extra } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => done({ status, stdout, stderr }));
  });
}

const stop = (child: ChildProcess) => new Promise(done => { child.on("close", done); child.kill(); });

test("emuly proxy checks its arguments, and errors never show the --via password", () => {
  for (const [args, message] of [[[], /Usage: emuly proxy/], [["phone-a", "--bogus"], /Unknown option --bogus/],
    [["phone-a", "sideways"], /Usage: emuly proxy/], [["phone-a", "--route", "carrier"], /--route is ssh or relay/],
    [["phone-a", "--via", `ftp://me:${SECRET}@host:21`], /does not support ftp/],
    [["phone-a", "--via", `http://me:${SECRET}@`], /--via is http/]] as const) {
    const result = spawnSync(process.execPath, [cli, "proxy", ...args], { encoding: "utf8", env: { ...env, EMULY_BASE_URL: "http://127.0.0.1:1" } });
    assert.equal(result.status, 1, String(args));
    assert.match(result.stderr, message);
    assert.ok(!(result.stdout + result.stderr).includes(SECRET));
  }
});

test("the local proxy refuses this computer's loopback and LAN unless --allow-lan", async t => {
  const target = await echo();
  const blocked = await localProxy([]);
  const open = await localProxy(["--allow-lan"]);
  t.after(async () => { target.server.close(); await stop(blocked.child); await stop(open.child); });
  assert.equal(blocked.line.lan, "blocked");
  for (const address of [`127.0.0.1:${target.port}`, "192.168.1.1:80", "10.0.0.1:443", "169.254.169.254:80", "[::1]:22", "[fe80::1]:80",
    // IPv4-mapped IPv6 in hex and long forms: 127.0.0.1 and 10.0.0.1.
    `[::ffff:7f00:1]:${target.port}`, `[0:0:0:0:0:ffff:7f00:1]:${target.port}`, `[::ffff:127.0.0.1]:${target.port}`, `[::7f00:1]:${target.port}`,
    "[::ffff:a00:1]:443", `[64:ff9b::7f00:1]:${target.port}`]) {
    assert.match(await connectThrough(blocked.line.local_port, address), /^HTTP\/1\.1 403/, address);
  }
  // A name that resolves to loopback is refused too.
  assert.match(await connectThrough(blocked.line.local_port, `localhost:${target.port}`), /^HTTP\/1\.1 403/);
  assert.match(await connectThrough(open.line.local_port, `127.0.0.1:${target.port}`), /^HTTP\/1\.1 200[^]*\r\n\r\necho:ping$/);
});

test("the local proxy only takes CONNECT", async t => {
  const proxy = await localProxy([]);
  t.after(() => stop(proxy.child));
  const reply = await new Promise<string>(done => {
    const socket = connect({ port: proxy.line.local_port, host: "127.0.0.1" });
    let out = ""; socket.on("data", (chunk: Buffer) => { out += chunk; }); socket.on("close", () => done(out));
    socket.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
  });
  assert.match(reply, /^HTTP\/1\.1 405/);
});

/** A fake upstream HTTP proxy that needs Basic auth `me:SECRET`, then echoes like echo(). */
async function httpUpstream(seen: string[]) {
  const server = createServer({ allowHalfOpen: true }, socket => {
    let head = "", open = false;
    const body: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      if (open) { body.push(chunk); return; }
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      seen.push(head.split("\r\n")[0]);
      const auth = /Proxy-Authorization: Basic (\S+)/.exec(head)?.[1];
      if (Buffer.from(auth ?? "", "base64").toString() !== `me:${SECRET}`) { socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return; }
      open = true; socket.write("HTTP/1.1 200 OK\r\n\r\n");
    });
    socket.on("end", () => { if (open) socket.end(Buffer.concat([Buffer.from("upstream:"), ...body])); });
  });
  return { server, port: await listen(server) };
}

test("--via http:// sends Basic auth upstream, and a wrong password gives 502 with no password in output", async t => {
  const seen: string[] = [];
  const upstream = await httpUpstream(seen);
  const good = await localProxy(["--via", `http://me:${SECRET}@127.0.0.1:${upstream.port}`]);
  const bad = await localProxy(["--via", `http://me:wrong-${SECRET}@127.0.0.1:${upstream.port}`]);
  t.after(async () => { upstream.server.close(); await stop(good.child); await stop(bad.child); });
  assert.equal(good.line.via, `http://127.0.0.1:${upstream.port}`);
  // With --via, names go to the upstream unresolved, so its own DNS is used.
  assert.match(await connectThrough(good.line.local_port, "example.test:443"), /\r\n\r\nupstream:ping$/);
  assert.deepEqual(seen, ["CONNECT example.test:443 HTTP/1.1"]);
  // A LAN address is still refused before it reaches the upstream.
  assert.match(await connectThrough(good.line.local_port, "192.168.1.1:80"), /^HTTP\/1\.1 403/);
  assert.match(await connectThrough(bad.line.local_port, "example.test:443"), /^HTTP\/1\.1 502/);
  await new Promise(done => setTimeout(done, 100));
  assert.match(bad.output(), /refused the user name or password/);
  assert.ok(!good.output().includes(SECRET) && !bad.output().includes(SECRET));
});

/** A fake SOCKS5 server that needs user/pass `me:SECRET`, takes a domain or IPv4, then echoes. */
async function socksUpstream(seen: string[]) {
  const server = createServer({ allowHalfOpen: true }, socket => {
    let buffer = Buffer.alloc(0), stage = 0;
    const body: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      if (stage === 3) { body.push(chunk); return; }
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2 + buffer[1]) {
        const methods = [...buffer.subarray(2, 2 + buffer[1])];
        buffer = buffer.subarray(2 + buffer[1]);
        if (!methods.includes(2)) { socket.end(Buffer.from([5, 0xff])); return; }
        socket.write(Buffer.from([5, 2])); stage = 1;
      }
      if (stage === 1 && buffer.length >= 2 && buffer.length >= 3 + buffer[1] && buffer.length >= 3 + buffer[1] + buffer[2 + buffer[1]]) {
        const user = buffer.subarray(2, 2 + buffer[1]).toString(), passLength = buffer[2 + buffer[1]];
        const pass = buffer.subarray(3 + buffer[1], 3 + buffer[1] + passLength).toString();
        buffer = buffer.subarray(3 + buffer[1] + passLength);
        if (user !== "me" || pass !== SECRET) { socket.end(Buffer.from([1, 1])); return; }
        socket.write(Buffer.from([1, 0])); stage = 2;
      }
      if (stage === 2 && buffer.length >= 5) {
        const type = buffer[3];
        const length = type === 1 ? 4 : type === 3 ? 1 + buffer[4] : 16;
        if (buffer.length < 4 + length + 2) return;
        const host = type === 1 ? [...buffer.subarray(4, 8)].join(".") : buffer.subarray(5, 5 + buffer[4]).toString();
        seen.push(`${host}:${buffer.readUInt16BE(4 + length)}`);
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); stage = 3;
      }
    });
    socket.on("end", () => { if (stage === 3) socket.end(Buffer.concat([Buffer.from("socks:"), ...body])); });
  });
  return { server, port: await listen(server) };
}

test("--via socks5:// does user/pass auth and sends names and IPs", async t => {
  const seen: string[] = [];
  const upstream = await socksUpstream(seen);
  const good = await localProxy(["--via", `socks5://me:${SECRET}@127.0.0.1:${upstream.port}`]);
  const bad = await localProxy(["--via", `socks5://me:nope@127.0.0.1:${upstream.port}`]);
  const none = await localProxy(["--via", `socks5://127.0.0.1:${upstream.port}`]);
  t.after(async () => { upstream.server.close(); await Promise.all([stop(good.child), stop(bad.child), stop(none.child)]); });
  assert.match(await connectThrough(good.line.local_port, "example.test:443"), /\r\n\r\nsocks:ping$/);
  assert.match(await connectThrough(good.line.local_port, "1.1.1.1:53"), /socks:ping$/);
  assert.deepEqual(seen, ["example.test:443", "1.1.1.1:53"]);
  assert.match(await connectThrough(bad.line.local_port, "example.test:443"), /^HTTP\/1\.1 502/);
  assert.match(await connectThrough(none.line.local_port, "example.test:443"), /^HTTP\/1\.1 502/);
  await new Promise(done => setTimeout(done, 100));
  assert.match(none.output(), /needs a user name and password/);
  assert.ok(![good, bad, none].some(proxy => proxy.output().includes(SECRET)));
});

/** A fake Emuly API that records calls. */
async function fakeApi(calls: string[]) {
  const server = createHttpServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/phones/phone-a/proxy") return response.end(JSON.stringify({ mode: request.method === "DELETE" ? "direct" : "laptop", udp: "blocked" }));
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { server, base: `http://127.0.0.1:${(server.address() as any).port}` };
}

test("a wrong --via password fails before any change to the phone, with no password in output", async t => {
  const seen: string[] = [], calls: string[] = [];
  const upstream = await httpUpstream(seen);
  const api = await fakeApi(calls);
  t.after(() => { upstream.server.close(); api.server.close(); });
  const result = await runCli(["proxy", "phone-a"], { EMULY_BASE_URL: api.base, EMULY_PROXY_VIA: `http://me:bad-${SECRET}@127.0.0.1:${upstream.port}` });
  assert.equal(result.status, 1);
  const line = JSON.parse(result.stdout.trim());
  assert.deepEqual([line.ok, line.error], [false, "via_auth"]);
  assert.ok(!(result.stdout + result.stderr).includes(SECRET));
  assert.deepEqual(calls.filter(call => call.includes("/proxy")), []);
});

test("emuly proxy <phone> status and off call the proxy API", async t => {
  const calls: string[] = [];
  const api = await fakeApi(calls);
  t.after(() => api.server.close());
  for (const [action, method, mode] of [["status", "GET", "laptop"], ["off", "DELETE", "direct"]]) {
    const result = await runCli(["proxy", "phone-a", action], { EMULY_BASE_URL: api.base });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mode, mode);
    assert.ok(calls.includes(`${method} /v1/phones/phone-a/proxy`));
  }
});

test("the CLI and the runner share the same IPv6 address parser", () => {
  const body = (file: string) => /\nfunction ipv6Groups\(ip\) \{\n[^]*?\n\}\n/.exec(readFileSync(resolve(file), "utf8"))?.[0];
  const cliCopy = body("bin/emuly.mjs");
  assert.ok(cliCopy, "bin/emuly.mjs has ipv6Groups");
  assert.equal(cliCopy, body("phone/runner/egress.mjs"));
});
