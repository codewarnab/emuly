// Links in the codespace. Each link is `adb reverse tcp:P tcp:P`, so the phone's localhost:P
// reaches the codespace's 127.0.0.1:P. Something must listen there:
// - Route A (ssh): `gh codespace ssh -R P:...` on the laptop makes sshd listen on 127.0.0.1:P.
// - Route B (relay): this file listens on 127.0.0.1:P and sends each connection, as one
//   numbered stream, through a websocket to the laptop (via the Emuly control plane).
// The emulator also reaches 127.0.0.1:P of the codespace as 10.0.2.2:P, so both addresses work.
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { FRAME, LINKS_MAX, LinkError, RELAY_CHUNK, decodeFrame, encodeFrame, linkPorts, linkPort, linkRoute,
  listeningPorts, logcatHints, netCheckHost, netCheckResult } from "./links-protocol.mjs";

/** A link whose tunnel stopped listening this long ago is removed. A laptop reconnect takes less. */
export const LINK_LOST_MS = 60_000;
/** A link that never got a tunnel is removed after this long. */
export const LINK_UNUSED_MS = 120_000;

/** Pause a TCP socket when the websocket has this many bytes waiting. */
const HIGH_WATER = 1024 * 1024;

export function createLinks({ adb, booted }) {
  /** @type {Map<number, { port: number, route: string, created_at: string, applied: boolean, relay?: Relay, seen?: boolean, lost_at?: number }>} */
  const links = new Map();

  async function reverse(port) {
    await adb(["reverse", `tcp:${port}`, `tcp:${port}`], { timeout: 10_000 });
  }

  async function listening() {
    const ports = new Set();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      const text = await readFile(file, "utf8").catch(() => "");
      for (const port of listeningPorts(text)) ports.add(port);
    }
    return ports;
  }

  async function list() {
    const open = await listening();
    return { links: [...links.values()].map(link => ({ port: link.port, route: link.route, created_at: link.created_at,
      applied: link.applied, listening: open.has(link.port), relay_connected: Boolean(link.relay) })) };
  }

  async function add(body) {
    const ports = linkPorts(body?.ports);
    const route = linkRoute(body?.route);
    const fresh = ports.filter(port => !links.has(port));
    if (links.size + fresh.length > LINKS_MAX) throw new LinkError(`A phone has at most ${LINKS_MAX} links. Remove one first.`);
    const ready = await booted();
    for (const port of ports) {
      const link = links.get(port) ?? { port, route, created_at: new Date().toISOString(), applied: false };
      if (link.route !== route) { link.relay?.close(); link.relay = undefined; link.route = route; }
      links.set(port, link);
      // Before boot, the link waits; POST /boot applies it.
      if (ready) { await reverse(port); link.applied = true; }
    }
    return list();
  }

  async function remove(body) {
    const ports = body?.port === undefined ? [...links.keys()] : [linkPort(body.port)];
    for (const port of ports) {
      const link = links.get(port);
      if (!link) continue;
      links.delete(port);
      link.relay?.close();
      await adb(["reverse", "--remove", `tcp:${port}`], { timeout: 10_000 }).catch(() => {});
    }
    return list();
  }

  /**
   * A runner restart forgets its links, but the phone keeps their adb reverse rules. Remove each
   * tcp rule that is not a link now. Only links make reverse rules (scrcpy uses adb forward).
   */
  async function sweep() {
    if (!await booted()) return;
    const list = String(await adb(["reverse", "--list"], { timeout: 10_000 }).catch(() => ""));
    for (const match of list.matchAll(/\btcp:(\d+)\s+tcp:\d+/g)) {
      const port = Number(match[1]);
      if (!links.has(port)) await adb(["reverse", "--remove", `tcp:${port}`], { timeout: 10_000 }).catch(() => {});
    }
  }

  /**
   * A link whose tunnel is gone holds an adb reverse rule that goes nowhere. This happens when the
   * laptop process is killed and cannot remove its links. The tunnel listens on 127.0.0.1:P (sshd
   * for Route A, the relay for Route B), so a port that stops listening means the tunnel is gone.
   * Remove a link LINK_LOST_MS after its tunnel goes, or LINK_UNUSED_MS after a create with no tunnel.
   */
  async function prune(now = Date.now()) {
    if (!links.size) return;
    const open = await listening();
    for (const link of [...links.values()]) {
      if (open.has(link.port)) { link.seen = true; link.lost_at = undefined; continue; }
      link.lost_at ??= now;
      const created = Date.parse(link.created_at);
      const expired = link.seen ? now - link.lost_at >= LINK_LOST_MS : now - created >= LINK_UNUSED_MS;
      if (expired) await remove({ port: link.port });
    }
  }
  const pruning = setInterval(() => { void prune().catch(() => {}); }, 15_000);
  pruning.unref?.();

  /** An emulator restart loses every adb reverse rule. Boot calls this. */
  async function reapply() {
    await sweep().catch(() => {});
    for (const link of links.values()) {
      try { await reverse(link.port); link.applied = true; }
      catch { link.applied = false; }
    }
  }

  /** The phone stopped. Its links stop too. */
  function clear() {
    for (const link of links.values()) link.relay?.close();
    links.clear();
  }

  /**
   * One relay websocket for some relay links. A later relay for the same port replaces this one,
   * for example after the laptop reconnects.
   */
  function relay(ws, ports) {
    let checked;
    try { checked = linkPorts(ports); }
    catch (error) { ws.close(4400, String(error.message).slice(0, 120)); return; }
    const missing = checked.find(port => links.get(port)?.route !== "relay");
    if (missing) { ws.close(4404, `No relay link for port ${missing}. Call POST /links first.`); return; }
    const owned = new Relay(ws, checked, () => {
      for (const port of checked) if (links.get(port)?.relay === owned) links.get(port).relay = undefined;
    });
    for (const port of checked) {
      const link = links.get(port);
      link.relay?.close();
      link.relay = owned;
    }
    owned.listen().catch(error => ws.close(4409, String(error?.code === "EADDRINUSE"
      ? "A process in the codespace already uses this port." : "The relay could not listen.").slice(0, 120)));
  }

  /**
   * Runs inside the emulator, so the answer is what the app sees. It sends a small HTTP request
   * and counts the reply. A link's tunnel accepts every connection, even when nothing listens
   * on the laptop; then it closes at once with no reply. So "connected" alone is not "reachable".
   */
  async function netCheck(body) {
    const host = netCheckHost(body?.host);
    const port = Number(body?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new LinkError("The port is a whole number from 1 to 65535.");
    if (!await booted()) throw Object.assign(new LinkError("Android is not ready. Start the phone first."), { status: 409 });
    const tmp = "/data/local/tmp/emuly-nc";
    // stdin stays open (sleep) because adb reverse ends a connection on a half-close.
    // timeout 3 ends a connection that stays open and silent: exit 124, which is reachable too.
    const output = String(await adb(["shell", `(printf 'HEAD / HTTP/1.0\\r\\nHost: ${host}\\r\\n\\r\\n'; sleep 3) `
      + `| timeout 3 toybox nc -w 3 ${host} ${port} >${tmp}.out 2>${tmp}.txt; echo "exit=$?"; echo "bytes=$(wc -c < ${tmp}.out)"; `
      + `cat ${tmp}.txt; rm -f ${tmp}.out ${tmp}.txt`], { timeout: 15_000 }).catch(error => error.stdout ?? ""));
    return { host, port, ...netCheckResult(output), logcat: await hints() };
  }

  async function hints() {
    const text = await adb(["logcat", "-d", "-t", "3000", "-v", "brief"], { timeout: 15_000 }).catch(() => "");
    return logcatHints(String(text));
  }

  return { list, add, remove, reapply, sweep, prune, clear, relay, netCheck, hints, count: () => links.size };
}

class Relay {
  constructor(ws, ports, onClose) {
    this.ws = ws;
    this.ports = ports;
    this.servers = [];
    this.streams = new Map();
    this.next = 1;
    this.closed = false;
    this.paused = new Set();
    /** App sockets whose write buffer is full. The websocket stays paused while any is full. */
    this.blocked = new Set();
    this.onClose = onClose;
    this.ping = setInterval(() => { try { ws.ping(); } catch {} }, 25_000);
    this.drain = setInterval(() => this.resume(), 50);
    ws.on("message", (data, binary) => { if (binary) this.receive(data); });
    ws.on("close", () => this.close());
    ws.on("error", () => this.close());
  }

  async listen() {
    for (const port of this.ports) {
      const server = createServer(socket => this.accept(socket, port));
      this.servers.push(server);
      // A replaced relay frees the port a moment after close(), so retry a few times.
      for (let attempt = 0; ; attempt++) {
        try {
          await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(undefined); });
          });
          break;
        } catch (error) {
          if (error?.code !== "EADDRINUSE" || attempt >= 5 || this.closed) throw error;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      if (this.closed) return server.close();
    }
  }

  accept(socket, port) {
    if (this.closed) return socket.destroy();
    const id = this.next++;
    if (this.next > 0xffffffff) this.next = 1;
    this.streams.set(id, socket);
    socket.setNoDelay(true);
    this.send(encodeFrame(FRAME.OPEN, id, port));
    socket.on("data", chunk => {
      for (let at = 0; at < chunk.length; at += RELAY_CHUNK) this.send(encodeFrame(FRAME.DATA, id, chunk.subarray(at, at + RELAY_CHUNK)));
      if (this.ws.bufferedAmount > HIGH_WATER) { socket.pause(); this.paused.add(socket); }
    });
    const done = () => {
      if (!this.streams.delete(id)) return;
      this.paused.delete(socket);
      this.send(encodeFrame(FRAME.CLOSE, id));
    };
    socket.on("end", done);
    socket.on("close", done);
    socket.on("error", () => socket.destroy());
  }

  receive(data) {
    const frame = decodeFrame(data);
    if (!frame) return;
    const socket = this.streams.get(frame.id);
    if (!socket) return;
    if (frame.type === FRAME.DATA) {
      // The laptop is faster than the app: stop reading the websocket until the socket drains.
      // A socket that closes before "drain" must also unblock, or the relay stalls for every stream.
      if (!socket.write(frame.data) && !this.blocked.has(socket)) {
        this.blocked.add(socket);
        const unblock = () => {
          socket.off("drain", unblock);
          socket.off("close", unblock);
          this.blocked.delete(socket);
          if (!this.blocked.size && !this.closed) this.ws.resume();
        };
        socket.on("drain", unblock);
        socket.on("close", unblock);
        this.ws.pause();
      }
    } else if (frame.type === FRAME.CLOSE) {
      this.streams.delete(frame.id);
      socket.end();
    }
  }

  resume() {
    if (!this.paused.size || this.ws.bufferedAmount > HIGH_WATER / 2) return;
    for (const socket of this.paused) socket.resume();
    this.paused.clear();
  }

  send(frame) {
    if (this.closed || this.ws.readyState !== 1) return;
    this.ws.send(frame, { binary: true });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    clearInterval(this.drain);
    for (const socket of this.streams.values()) socket.destroy();
    this.streams.clear();
    for (const server of this.servers) server.close();
    try { this.ws.close(1000, "relay closed"); } catch {}
    this.onClose();
  }
}
