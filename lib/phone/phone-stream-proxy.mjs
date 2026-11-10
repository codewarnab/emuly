import { asyncDb } from "../data/async-db.ts";
import { takeSharedStreamTicket } from "./shared-stream-ticket.ts";
import ws from "next/dist/compiled/ws/index.js";
import { takeStreamTicket } from "./phone-stream-ticket.ts";

/** key=value only. Never log headers, tokens, ticket values, cookies, or URLs with query strings. */
function streamLog(event, fields) {
  const clean = value => String(value).replace(/gh[opsu]_[A-Za-z0-9_]{8,}/g, "[redacted]")
    .replace(/\b(token|ticket|secret|cookie)=[^&\s]+/gi, "$1=[redacted]")
    .replace(/[^\w.@:+-]/g, "_");
  console.warn(`[stream] ${event} ${Object.entries(fields).filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${clean(value)}`).join(" ")}`);
}

/** ws reports "Unexpected server response: 401"; fall back to a transport code such as ECONNRESET. */
function upstreamStatus(error) {
  const response = /Unexpected server response: (\d{3})/.exec(error?.message ?? "");
  return response ? Number(response[1]) : error?.code ?? "unknown";
}

const STATE_LOOKUP_MS = 10_000;

async function defaultSnapshot(userId, phoneId) {
  try { return await (await import("./phone-control.ts")).codespaceSnapshot(userId, phoneId); }
  catch { return; }
}
async function defaultRecord(userId, phoneId, codespace) {
  try { await (await import("./phone-control.ts")).recordCodespaceState(userId, phoneId, codespace); }
  catch { /* The poller records the next state; a failed observation must not fail the stream. */ }
}

export function attachPhoneStreams(server, nextUpgrade, { snapshot = defaultSnapshot, record = defaultRecord } = {}) {
  const sockets = new ws.WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
  // At most one provider lookup per phone per 10 s, including failed lookups, so a burst of
  // reconnecting viewers cannot multiply GitHub requests.
  const snapshots = new Map();
  const observed = new Map();
  const snapshotFor = (userId, phoneId) => {
    const key = `${userId}:${phoneId}`;
    const cached = snapshots.get(key);
    if (cached && Date.now() - cached.at < STATE_LOOKUP_MS) return cached.promise;
    const entry = { at: Date.now(), promise: (async () => {
      try { return await snapshot(userId, phoneId); }
      catch { return undefined; }
    })() };
    snapshots.set(key, entry);
    return entry.promise;
  };
  server.on("upgrade", async (req, socket, head) => {
    const startedAt = Date.now();
    let url, phoneId;
    try { url = new URL(req.url ?? "/", "http://localhost"); phoneId = decodeURIComponent(url.pathname.split("/")[3] ?? ""); }
    catch { return socket.destroy(); }
    const match = /^\/app\/phones\/([^/]+)\/(stream|frames)$/.exec(url.pathname);
    if (!match) return nextUpgrade(req, socket, head);
    let userId;
    let ticket = takeStreamTicket(url.searchParams.get("ticket") ?? "", phoneId,
      req.headers.origin ?? "", req.headers.cookie ?? "");
    if (ticket) userId = ticket.userId;
    if (!ticket) {
      try {
        const shared = await takeSharedStreamTicket(asyncDb(), url.searchParams.get("ticket") ?? "", phoneId, req.headers.origin ?? "", req.headers.cookie ?? "");
        if (shared && match[2] === "frames") {
          const { servePngFrames } = await import("./png-stream.ts");
          const { runnerFrame } = await import("./runner-frame.ts");
          return sockets.handleUpgrade(req, socket, head, browser => {
            browser.on("error", () => browser.close());
            void servePngFrames(browser, () => runnerFrame(shared.userId, phoneId, shared.sessionId));
          });
        }
        if (shared) { userId = shared.userId; ticket = { open: async () => (await import("./phone-runner.ts")).runnerStream(shared.userId, phoneId, shared.sessionId) }; }
      } catch (error) { console.warn(`[stream] ${phoneId}: shared ticket failed:`, error?.message ?? error); return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
    }
    if (!ticket) { console.warn(`[stream] ${phoneId}: ticket rejected`); return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
    let lease;
    // Fix 4: ticket.open() can wait up to 90 s. A browser reset (ECONNRESET) in that time hit a socket
    // with no "error" listener, which Node turns into an uncaughtException that can stop the server.
    // Do not remove this listener "for efficiency". The destroyed check below and the close handler
    // release the lease, so the viewer count and the keep-awake timer stay correct.
    socket.on("error", error => {
      streamLog("browser_socket_error", { phone: phoneId, code: error?.code ?? "unknown", elapsed_ms: Date.now() - startedAt });
      socket.destroy();
    });
    const timeout = setTimeout(() => socket.destroy(), 90_000);
    try {
      lease = await ticket.open();
      if (socket.destroyed || lease.signal.aborted) { lease.release(); return socket.destroy(); }
      const quality = ["auto", "sharp", "saver"].includes(url.searchParams.get("quality")) ? url.searchParams.get("quality") : "auto";
      const upstream = new ws(lease.url + `?quality=${quality}`, { headers: lease.headers, followRedirects: false,
        handshakeTimeout: 15_000, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
      let client, opened = false, openedAt = 0, sentBytes = 0, sentFrames = 0, loggedClose = false;
      // investigating: the upgrade failed before open and the provider is being checked.
      // handedOff: the browser socket now carries a deliberate 4001 close, not a destroy.
      let investigating = false, handedOff = false, closedBy;
      const teardown = () => { upstream.terminate(); client?.terminate(); lease.release(); };
      const abort = () => { closedBy ??= "lease_abort"; teardown(); };
      lease.signal.addEventListener("abort", abort, { once: true });
      const logClose = () => {
        if (!opened || loggedClose) return;
        loggedClose = true;
        streamLog("upstream_closed", { phone: phoneId, route: lease.route ?? "unknown",
          duration_ms: Date.now() - openedAt, bytes: sentBytes, frames: sentFrames, closer: closedBy ?? "unknown" });
      };
      const investigate = async (error, viewers) => {
        const status = upstreamStatus(error);
        const codespace = typeof userId === "number" ? await snapshotFor(userId, phoneId) : undefined;
        const state = codespace?.state;
        const route = lease.route ?? "unknown";
        const key = `${userId}:${phoneId}`;
        const previous = observed.get(key);
        const awake = lease.lastAwakeSuccess;
        const elapsedMs = Date.now() - startedAt;
        if (state) observed.set(key, state);
        // No tunnel or retry can revive a codespace GitHub is shutting down, so tell the page it stopped.
        // Do not remove this check "for efficiency" or to simplify retries: it is the only place that
        // distinguishes the measured 401-while-ShuttingDown from a transient 401 on a live runner.
        if (state && state !== "Available") {
          streamLog("phone_stopped", { phone: phoneId, route, status, elapsed_ms: elapsedMs, state,
            changed: previous !== undefined && previous !== state, viewers,
            since_awake_ms: awake ? Date.now() - awake : "none", action: "phone_stopped" });
          if (typeof userId === "number") void Promise.resolve().then(() => record(userId, phoneId, codespace)).catch(() => {});
          if (socket.destroyed) { investigating = false; teardown(); return; }
          handedOff = true;
          upstream.terminate();
          lease.drop?.();
          try {
            sockets.handleUpgrade(req, socket, head, browser => {
              browser.on("error", () => browser.close());
              browser.close(4001, "phone_stopped");
            });
          } catch { socket.destroy(); }
          return;
        }
        investigating = false;
        streamLog("upstream_failed", { phone: phoneId, route, status, elapsed_ms: elapsedMs,
          state: state ?? "unknown", viewers, since_awake_ms: awake ? Date.now() - awake : "none",
          action: route === "forwarded" ? "fallback_tunnel" : "retry" });
        lease.failed?.();
        socket.destroy();
        teardown();
      };
      upstream.on("error", error => {
        if (opened) { streamLog("upstream_error", { phone: phoneId, route: lease.route ?? "unknown",
          status: upstreamStatus(error), elapsed_ms: Date.now() - openedAt, opened: true }); socket.destroy(); teardown(); return; }
        // Keep the browser socket alive while the provider state is checked, so a stopped phone
        // receives the 4001 close instead of an opaque network drop.
        if (investigating || handedOff) return;
        investigating = true;
        const viewers = lease.viewers ?? 0;
        void investigate(error, viewers).catch(() => {
          investigating = false;
          lease.failed?.();
          socket.destroy();
          teardown();
        });
      });
      socket.once("close", () => { closedBy ??= "browser"; teardown(); });
      upstream.once("close", () => {
        lease.signal.removeEventListener("abort", abort);
        closedBy ??= "upstream";
        if (!investigating && !handedOff) socket.destroy();
        logClose();
        teardown();
      });
      upstream.once("open", () => {
        opened = true; openedAt = Date.now();
        if (socket.destroyed || lease.signal.aborted) return teardown();
        sockets.handleUpgrade(req, socket, head, browser => {
          client = browser;
          browser.on("error", teardown);
          browser.on("close", () => { closedBy ??= "browser"; teardown(); });
          browser.on("message", (data, binary) => {
            if (binary || upstream.bufferedAmount > 65_536) return teardown();
            upstream.send(data, { binary: false });
          });
          upstream.on("message", (data, binary) => {
            if (!binary && data.length < 1024) {
              try { const summary = JSON.parse(data.toString()); if (summary.type === "pong" && summary.inputAccepted === true) lease.acceptedInput?.(); }
              catch { /* Invalid upstream messages are never diagnostics. */ }
            }
            if (browser.bufferedAmount > 4 * 1024 * 1024) return teardown();
            sentBytes += data.length ?? data.byteLength ?? 0;
            if (binary) sentFrames++;
            browser.send(data, { binary });
          });
        });
      });
    } catch (error) { streamLog("runner_open_failed", { phone: phoneId, error: String(error?.message ?? error).slice(0, 120) }); lease?.release(); socket.destroy(); }
    finally { clearTimeout(timeout); }
  });
}
