import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect, type Server, type Socket } from "node:net";
import { createSocket } from "node:dgram";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockedAddress, createEgress, egressSetting, parseHead } from "../../phone/runner/egress.mjs";
import { createDnsForwarder, queryOverLink, servfail, tcpFrame } from "../../phone/runner/egress-dns.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "egress-"));
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port)));

/** A TCP echo server that replies after the client half-closes, like a download after the request. */
async function echoServer() {
  const server = createServer({ allowHalfOpen: true }, socket => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => socket.end(Buffer.concat([Buffer.from("echo:"), ...chunks])));
  });
  return { server, port: await listen(server) };
}

/** A fake `emuly proxy` on the laptop: answers CONNECT with 200 (or `status`), then echoes like echoServer. */
async function laptopProxy(status = 200, seen: string[] = []) {
  const server = createServer({ allowHalfOpen: true }, socket => {
    let head = Buffer.alloc(0), open = false;
    const body: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      if (open) { body.push(chunk); return; }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      seen.push(head.subarray(0, head.indexOf("\r\n")).toString());
      if (status !== 200) { socket.end(`HTTP/1.1 ${status} No\r\n\r\n`); return; }
      open = true;
      socket.write("HTTP/1.1 200 OK\r\n\r\n");
      if (head.length > end + 4) body.push(head.subarray(end + 4));
    });
    socket.on("end", () => { if (open) socket.end(Buffer.concat([Buffer.from("laptop:"), ...body])); });
  });
  return { server, port: await listen(server), seen };
}

/** Sends one request through the gateway, half-closes, and collects the whole reply. */
function through(port: number, head: string, body = "") {
  return new Promise<string>(resolve => {
    const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    let out = "", sent = false;
    socket.on("data", (chunk: Buffer) => {
      out += chunk.toString("latin1");
      if (!sent && head.startsWith("CONNECT") && out.includes("\r\n\r\n")) { sent = true; socket.end(body); }
    });
    socket.on("end", () => socket.end());
    socket.on("close", () => resolve(out));
    socket.on("error", () => {});
    socket.write(head);
    if (!head.startsWith("CONNECT")) socket.end(body);
  });
}

async function gateway(options: Record<string, unknown> = {}) {
  const egress = createEgress({ file: join(dir(), "egress.json"), listenPort: 0, ...options });
  await egress.listen();
  return egress;
}

test("parseHead reads CONNECT, IPv6 and the absolute http form", () => {
  assert.equal(parseHead(Buffer.from("CONNECT 1.2.3.4:443 HTTP/1.1\r\nHost: x")), undefined);
  const connectHead = parseHead(Buffer.from("CONNECT 1.2.3.4:443 HTTP/1.1\r\nHost: 1.2.3.4:443\r\n\r\nhello"))!;
  assert.deepEqual([connectHead.kind, connectHead.host, connectHead.port, connectHead.rest.toString()], ["connect", "1.2.3.4", 443, "hello"]);
  assert.equal(parseHead(Buffer.from("CONNECT [2606:4700::1111]:853 HTTP/1.1\r\n\r\n"))!.host, "2606:4700::1111");
  const http = parseHead(Buffer.from("GET http://Example.com/a?b=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive\r\n\r\n"))!;
  assert.deepEqual([http.kind, http.host, http.port], ["http", "example.com", 80]);
  assert.equal(http.head.toString(), "GET /a?b=1 HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
  assert.equal(parseHead(Buffer.from("GET http://example.com:8080 HTTP/1.0\r\n\r\n"))!.head.toString().split("\r\n")[0], "GET / HTTP/1.0");
  assert.throws(() => parseHead(Buffer.from("GET /local HTTP/1.1\r\n\r\n")), /CONNECT/);
  assert.throws(() => parseHead(Buffer.from("CONNECT a:99999 HTTP/1.1\r\n\r\n")), /port/i);
  assert.throws(() => parseHead(Buffer.alloc(20_000, 65)), /too large/);
});

test("blockedAddress refuses private, loopback, link-local and mapped ranges", () => {
  for (const ip of ["10.1.2.3", "127.0.0.53", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a00:1", "64:ff9b::10.0.0.1", "64:ff9b:1::1", "not-an-ip",
    // Mapped IPv4 in hex and long forms: 127.0.0.1, 10.0.0.1 and 169.254.169.254.
    "::ffff:7f00:1", "::FFFF:7F00:0001", "0:0:0:0:0:ffff:7f00:1", "0000::ffff:127.0.0.1", "::7f00:1", "::ffff:a00:1", "::ffff:a9fe:a9fe",
    "64:ff9b:0:0:0:0:7f00:1", "2001:db8::1"]) {
    assert.equal(blockedAddress(ip), true, ip);
  }
  for (const ip of ["1.1.1.1", "140.82.112.4", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::681a:dcd", "64:ff9b::1.1.1.1", "::ffff:808:808", "0:0:0:0:0:ffff:101:101"]) {
    assert.equal(blockedAddress(ip), false, ip);
  }
});

test("egressSetting checks the mode and the link port", () => {
  assert.deepEqual(egressSetting({ mode: "direct", port: 9000, lock: true }), { mode: "direct", port: undefined, lock: false });
  assert.deepEqual(egressSetting({ mode: "laptop", port: 18792, lock: true }), { mode: "laptop", port: 18792, lock: true });
  assert.throws(() => egressSetting({ mode: "vpn" }), /mode/);
  assert.throws(() => egressSetting({ mode: "laptop" }), /port/);
  assert.throws(() => egressSetting({ mode: "laptop", port: 8790 }), /port/);
  assert.throws(() => egressSetting({ mode: "laptop", port: 80 }), /port/);
});

test("direct mode: 127.0.0.1 passes with half-close; Emuly ports and private targets are refused", async t => {
  const echo = await echoServer();
  const egress = await gateway({ lookup: (_host: string, _options: unknown, callback: Function) => callback(null, [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.5", family: 4 }]) });
  t.after(() => { echo.server.close(); void egress.close(); });
  const port = egress.port();
  // 10.0.2.2:X reaches the gateway as 127.0.0.1:X. The reply comes after the client's half-close.
  assert.match(await through(port, `CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\n\r\n`, "ping"), /200 Connection established\r\n\r\necho:ping$/);
  assert.equal(await through(port, "CONNECT 127.0.0.1:5037 HTTP/1.1\r\n\r\n"), "");
  assert.equal(await through(port, "CONNECT 127.0.0.1:8790 HTTP/1.1\r\n\r\n"), "");
  assert.equal(await through(port, "CONNECT 192.168.1.1:22 HTTP/1.1\r\n\r\n"), "");
  assert.equal(await through(port, "CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n"), "");
  // A name that resolves to a private address is refused too (no DNS rebinding to the codespace).
  assert.match(await through(port, "GET http://internal.example/ HTTP/1.1\r\nHost: internal.example\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.match(await through(port, "BREW /pot HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 400/);
  const counters = egress.status().counters;
  assert.equal(counters.refused, 6);
  assert.equal(counters.connections, 7);
  assert.ok(counters.bytes_down >= "echo:ping".length);
});

test("plain http is rewritten to a path, sent with Connection: close, and survives a client half-close", async t => {
  let got = "";
  // Like api.ipify.org: the server drops the request if the client half-closes before the reply.
  const origin = createServer({ allowHalfOpen: true }, socket => {
    socket.once("end", () => socket.destroy());
    socket.once("data", (chunk: Buffer) => { got = chunk.toString(); setTimeout(() => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"), 30); });
  });
  const originPort = await listen(origin);
  const egress = await gateway();
  t.after(() => { origin.close(); void egress.close(); });
  const reply = await through(egress.port(), `GET http://127.0.0.1:${originPort}/x HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Connection: keep-alive\r\n\r\n`);
  assert.match(reply, /\r\n\r\nok$/);
  assert.equal(got, "GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
});

test("laptop mode sends CONNECT to the link, refuses Private DNS, and fails closed when the link is down", async t => {
  const laptop = await laptopProxy();
  const egress = await gateway();
  t.after(() => { laptop.server.close(); void egress.close(); });
  await egress.set({ mode: "laptop", port: laptop.port });
  const port = egress.port();
  assert.match(await through(port, "CONNECT example.com:443 HTTP/1.1\r\n\r\n", "tls"), /200 Connection established\r\n\r\nlaptop:tls$/);
  assert.match(await through(port, "CONNECT [2606:4700::1111]:443 HTTP/1.1\r\n\r\n", "v6"), /laptop:v6$/);
  assert.deepEqual(laptop.seen, ["CONNECT example.com:443 HTTP/1.1", "CONNECT [2606:4700::1111]:443 HTTP/1.1"]);
  // Android Private DNS asks for 10.0.2.3:853. Refused, so Android uses port 53 (the forwarder).
  assert.equal(await through(port, "CONNECT 10.0.2.3:853 HTTP/1.1\r\n\r\n"), "");
  assert.equal(laptop.seen.length, 2);
  // Link down: the connection fails. Nothing goes direct.
  await new Promise(resolve => laptop.server.close(resolve));
  assert.equal(await through(port, "CONNECT example.com:443 HTTP/1.1\r\n\r\n"), "");
  assert.match(await through(port, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n"), /^HTTP\/1\.1 502/);
  assert.equal(await egress.upstreamOpen(), false);
});

test("laptop mode: a refusal from the laptop closes the phone's connection", async t => {
  const laptop = await laptopProxy(403);
  const egress = await gateway();
  t.after(() => { laptop.server.close(); void egress.close(); });
  await egress.set({ mode: "laptop", port: laptop.port });
  assert.equal(await through(egress.port(), "CONNECT 192.168.1.10:80 HTTP/1.1\r\n\r\n"), "");
  assert.equal(egress.status().counters.refused, 1);
});

test("the mode file survives a restart, and a bad file means direct", async () => {
  const file = join(dir(), "sub", "egress.json");
  const first = createEgress({ file });
  await first.set({ mode: "laptop", port: 18792, lock: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).mode, "laptop");
  const second = createEgress({ file });
  const loaded = await second.load();
  assert.deepEqual([loaded.mode, loaded.port, loaded.lock], ["laptop", 18792, true]);
  writeFileSync(file, '{"mode":"laptop","port":5037}');
  assert.equal((await createEgress({ file }).load()).mode, "direct");
  writeFileSync(file, "not json");
  assert.equal((await createEgress({ file }).load()).mode, "direct");
});

test("a mode change ends the open connections", async t => {
  const hold = createServer(() => {});
  const holdPort = await listen(hold);
  const egress = await gateway();
  t.after(() => { hold.close(); void egress.close(); });
  const socket = connect({ port: egress.port(), host: "127.0.0.1" });
  socket.write(`CONNECT 127.0.0.1:${holdPort} HTTP/1.1\r\n\r\n`);
  await new Promise(resolve => socket.once("data", resolve));
  const closed = new Promise(resolve => socket.once("close", resolve));
  await egress.set({ mode: "laptop", port: 18792 });
  await closed;
});

test("check() gets the exit IP through the gateway path", async t => {
  const laptop = createServer(socket => {
    socket.once("data", () => {
      socket.write("HTTP/1.1 200 OK\r\n\r\n");
      socket.once("data", () => socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ip":"203.0.113.9"}'));
    });
  });
  const laptopPort = await listen(laptop);
  const egress = await gateway();
  t.after(() => { laptop.close(); void egress.close(); });
  await egress.set({ mode: "laptop", port: laptopPort });
  const result = await egress.check();
  assert.deepEqual([result.ok, result.mode, result.exit_ip], [true, "laptop", "203.0.113.9"]);
  laptop.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await egress.check()).ok, false);
});

// --- DNS forwarder -----------------------------------------------------------------------------

const query = Buffer.from("12340100000100000000000003777777076578616d706c6503636f6d0000010001", "hex");

test("servfail and tcpFrame build valid DNS messages", () => {
  const reply = servfail(query)!;
  assert.equal(reply.readUInt16BE(0), 0x1234);
  assert.equal(reply[2] & 0x80, 0x80);
  assert.equal(reply[3] & 0x0f, 2);
  assert.equal(reply.readUInt16BE(4), 1);
  assert.equal(servfail(Buffer.alloc(4)), undefined);
  assert.deepEqual([...tcpFrame(Buffer.from([1, 2, 3])).subarray(0, 2)], [0, 3]);
});

/** A fake laptop that answers CONNECT, then reads one DNS-over-TCP query and answers it. */
async function laptopDns(seen: string[] = []) {
  const server = createServer(socket => {
    let buffer = Buffer.alloc(0), open = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!open) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        seen.push(buffer.subarray(0, buffer.indexOf("\r\n")).toString());
        open = true; buffer = buffer.subarray(end + 4);
        socket.write("HTTP/1.1 200 OK\r\n\r\n");
      }
      if (buffer.length >= 2 && buffer.length >= 2 + buffer.readUInt16BE(0)) {
        const answer = Buffer.from(buffer.subarray(2, 2 + buffer.readUInt16BE(0)));
        answer[2] |= 0x80;
        socket.write(tcpFrame(answer));
      }
    });
  });
  return { server, port: await listen(server), seen };
}

function ask(port: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const client = createSocket("udp4");
    const timer = setTimeout(() => { client.close(); reject(new Error("no answer")); }, 3000);
    client.once("message", message => { clearTimeout(timer); client.close(); resolve(message); });
    client.send(query, port, "127.0.0.1");
  });
}

test("queryOverLink sends DNS over TCP inside a CONNECT", async t => {
  const laptop = await laptopDns();
  t.after(() => laptop.server.close());
  const answer = await queryOverLink(query, { host: "127.0.0.1", port: laptop.port, resolver: "1.1.1.1:53" }) as Buffer;
  assert.equal(answer.readUInt16BE(0), 0x1234);
  assert.deepEqual(laptop.seen, ["CONNECT 1.1.1.1:53 HTTP/1.1"]);
});

test("the forwarder uses the codespace resolver in direct mode and the link in laptop mode, SERVFAIL when it is down", async t => {
  const resolver = createSocket("udp4");
  await new Promise<void>(resolve => resolver.bind(0, "127.0.0.1", () => resolve()));
  resolver.on("message", (message, from) => { const answer = Buffer.from(message); answer[2] |= 0x80; answer[3] = 0x80; resolver.send(answer, from.port, from.address); });
  const laptop = await laptopDns();
  const file = join(dir(), "egress.json");
  const forwarder = createDnsForwarder({ file, address: "127.0.0.1", port: 0, resolver: { host: "127.0.0.1", port: (resolver.address() as any).port } });
  const port = await forwarder.listen();
  t.after(() => { resolver.close(); laptop.server.close(); forwarder.close(); });

  const direct = await ask(port);
  assert.deepEqual([direct.readUInt16BE(0), direct[3] & 0x0f], [0x1234, 0]);
  assert.equal(laptop.seen.length, 0);

  writeFileSync(file, JSON.stringify({ mode: "laptop", port: laptop.port }));
  const viaLaptop = await ask(port);
  assert.deepEqual([viaLaptop.readUInt16BE(0), viaLaptop[2] & 0x80], [0x1234, 0x80]);
  assert.deepEqual(laptop.seen, ["CONNECT 1.1.1.1:53 HTTP/1.1"]);

  await new Promise(resolve => laptop.server.close(resolve));
  // mtime can be equal within one tick; write a different port to change the file.
  writeFileSync(file, JSON.stringify({ mode: "laptop", port: laptop.port, lock: true }));
  const down = await ask(port);
  assert.equal(down[3] & 0x0f, 2);
  assert.deepEqual(forwarder.counters(), { queries: 3, laptop: 2, failed: 1 });
});

test("an unlocked laptop proxy with no laptop goes back to direct; a locked one stays", async t => {
  // A port with nothing on it: the laptop link is gone.
  const probe = createServer(), unused = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const open = createEgress({ file: join(dir(), "egress.json"), listenPort: 0, orphanMs: 50, watchMs: 20 });
  const locked = createEgress({ file: join(dir(), "egress.json"), listenPort: 0, orphanMs: 50, watchMs: 20 });
  t.after(() => Promise.all([open.close(), locked.close()]));
  await open.listen(); await locked.listen();
  await open.set({ mode: "laptop", port: unused });
  await locked.set({ mode: "laptop", port: unused, lock: true });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(open.status().mode, "direct");
  assert.equal(locked.status().mode, "laptop");
});
