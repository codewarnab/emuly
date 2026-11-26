import "server-only";
import { PORTS, runnerHost } from "../../phone/runner/contracts.mjs";
import { measure } from "../diagnostics/diagnostics.ts";
import { ADB_DOWNLOAD_MAX_BYTES } from "./phone-adb-contract.ts";
import type { phoneObservations } from "./phone-observation.ts";
import { RunnerTimeoutError } from "./runner-errors.ts";
import { runnerUpdateMessage } from "./phone-response.ts";

type Bridge = { url: string; close: () => void };
type Owner = { userId: number; id: string; codespaceName: string };
/** relayCookie: GitHub's port-forwarding session cookie. Memory only; never logged or stored. */
type Connection = Bridge & { forwarded: boolean; relayCookie?: string };
const RELAY_COOKIE = ".Tunnels.Relay.WebForwarding.Cookies";

/** The relay cookie from a forwarded reply, as name=value. Undefined when the reply sets none. */
export function relayCookie(response: Response): string | undefined {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const pair = line.split(";")[0].trim();
    if (pair.startsWith(`${RELAY_COOKIE}=`) && pair.length > RELAY_COOKIE.length + 1) return pair;
  }
  return undefined;
}
type Entry = { connection: Promise<Connection>; abort: AbortController; active: number; viewers: number; timer?: NodeJS.Timeout; awake?: NodeJS.Timeout;
  lastAwakeSuccess?: number };
class RunnerResponseError extends Error {}

/** key=value only. Never log headers, tokens, ticket values, cookies, or URLs with query strings. */
function streamLog(event: string, fields: Record<string, string | number | undefined>) {
  const clean = (value: string | number) => String(value).replace(/gh[opsu]_[A-Za-z0-9_]{8,}/g, "[redacted]")
    .replace(/\b(token|ticket|secret|cookies?)=[^&\s;]+/gi, "$1=[redacted]")
    .replace(/[^\w.@:+-]/g, "_");
  console.warn(`[stream] ${event} ${Object.entries(fields).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${clean(value!)}`).join(" ")}`);
}

/** A provider message may quote the credential or a ticket; strip both before it reaches a log. */
function safeErrorText(error: unknown, secret = "") {
  const message = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return (secret ? message.replaceAll(secret, "[redacted]") : message)
    .replace(/gh[opsu]_[A-Za-z0-9_]{8,}/g, "[redacted]")
    .replace(/\b(token|ticket|secret|cookies?)=[^&\s;]+/gi, "$1=[redacted]")
    .slice(0, 120);
}
/**
 * On Vercel a function stops after 300 s. End the /boot call well before that, so the result
 * (or the "still booting" check) is saved. Android keeps booting; the next sync joins the boot.
 */
const BOOT_REQUEST_MS = process.env.VERCEL ? 240_000 : 1_200_000;
export type RunnerPath = "/health" | "/boot" | "/stop" | "/screenshot" | "/ui" | "/tap" | "/key" | "/agent-device-info" | "/direct/revoke";
export type LinksPath = "/links" | "/links/remove" | "/net-check" | "/link-hints" | "/egress" | "/egress/check";
export type AppsPath = "/apps" | "/apps/open" | "/app-installs" | `/app-installs/${string}` | "/file-fetches" | `/file-fetches/${string}`;
export type AppsRequest = { method: "GET" | "POST" | "PUT"; json?: Record<string, unknown>; bytes?: Uint8Array; offset?: number; digest?: string; signal?: AbortSignal };
export type AdbRequest = { args: string[]; timeout_s: number; binary?: boolean; files?: { name: string; bytes: Uint8Array }[]; key?: string };
export type RecordingAction = "start" | "stop" | "status" | "file" | "discard" | "grid" | "mark" | "notes";
export type ProxyRequest = { method: string; headers: Headers; body?: ReadableStream<Uint8Array> | null; signal?: AbortSignal };

/** One connection per owned phone. Only a read-only probe may fall back; never replay a mutation. */
export function createEmulyLinks({ token, tunnel, keepAwake, activity, observations, fetch: request = fetch, idleMs = 120_000, runnerKey = () => undefined }: {
  token: (userId: number) => Promise<string>;
  /** The runner key for a codespace, sent as `x-phone-secret` (phone/runner/runner-key.mjs). Undefined sends none. */
  runnerKey?: (codespaceName: string) => string | undefined;
  tunnel: (token: string, name: string, signal: AbortSignal) => Promise<Bridge>;
  keepAwake?: (token: string, name: string) => Promise<unknown>;
  /** Records human and agent actions, and says whether the phone had one within its idle time. */
  activity?: { mark(phone: Owner): void; recent(phone: Owner): Promise<boolean> };
  fetch?: typeof fetch;
  idleMs?: number;
  observations?: ReturnType<typeof phoneObservations>;
}) {
  const entries = new Map<string, Entry>();
  const streamFallback = new Set<string>();
  const key = (phone: Owner) => `${phone.userId}:${phone.id}:${phone.codespaceName}`;
  // reason: why the shared connection closed. Every stream on it ends with "lease_abort", so the
  // proxy logs signal.reason to tell an idle timeout from a failed request or a phone stop.
  const close = (phone: Owner, reason = "phone_state_change") => {
    const entry = entries.get(key(phone));
    if (!entry) return;
    entries.delete(key(phone));
    clearTimeout(entry.timer);
    clearInterval(entry.awake);
    if (entry.awake) observations?.mark(phone, "awake_timer_stop", { count: entry.viewers, errorCode: "observer_shutdown" });
    entry.abort.abort(reason);
    void entry.connection.then(connection => connection.close(), () => {});
  };
  /** Adds the runner key to every runner request. Never log it. */
  const withKey = <T extends Headers | Record<string, string>>(phone: Owner, headers: T): T => {
    const value = runnerKey(phone.codespaceName);
    if (value) { if (headers instanceof Headers) headers.set("x-phone-secret", value); else (headers as Record<string, string>)["x-phone-secret"] = value; }
    return headers;
  };
  async function connect(phone: Owner, signal: AbortSignal): Promise<Connection> {
    const secret = await measure("credential_lookup", () => token(phone.userId));
    const url = `https://${runnerHost(phone.codespaceName, PORTS.RUNNER)}`;
    const forceTunnel = streamFallback.delete(key(phone));
    try {
      if (forceTunnel) throw new Error("WebSocket forwarding unavailable");
      const probe = await measure("forwarded_probe", () => request(`${url}/health`, { headers: { "X-Github-Token": secret },
        redirect: "manual", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }), { route: "forwarded" });
      if (probe.ok && probe.headers.get("content-type")?.includes("application/json") && (await probe.json()).ok === true) {
        return { url, forwarded: true, relayCookie: relayCookie(probe), close() {} };
      }
      await probe.body?.cancel();
    } catch { signal.throwIfAborted(); }
    return { ...await tunnel(secret, phone.codespaceName, signal), forwarded: false };
  }
  function acquire(phone: Owner) {
    if (!/^[\w-]{1,100}$/.test(phone.codespaceName)) throw new Error("Invalid codespace name");
    let entry = entries.get(key(phone));
    if (!entry) {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 90_000);
      const opening = (observations ? observations.scope(phone, () => connect(phone, abort.signal)) : connect(phone, abort.signal)).then(connection => {
        if (abort.signal.aborted) { connection.close(); abort.signal.throwIfAborted(); }
        return connection;
      });
      let cancelled: () => void;
      const cancellation = new Promise<never>((_, reject) => {
        cancelled = () => reject(new Error("Connection cancelled"));
        abort.signal.addEventListener("abort", cancelled, { once: true });
      });
      entry = { abort, active: 0, viewers: 0, connection: Promise.race([opening, cancellation]).finally(() => {
        clearTimeout(timeout);
        abort.signal.removeEventListener("abort", cancelled);
      }) };
      entries.set(key(phone), entry);
    }
    clearTimeout(entry.timer);
    entry.active++;
    let released = false;
    return { entry, release() {
      if (released) return;
      released = true;
      entry.active--;
      if (!entry.active && entries.get(key(phone)) === entry) {
        entry.timer = setTimeout(() => { if (entries.get(key(phone)) === entry) close(phone, "idle_timeout"); }, idleMs);
        entry.timer.unref();
      }
    } };
  }
  /**
   * A call through GitHub port forwarding. GitHub checks X-Github-Token on each request, and that
   * check takes about 1.1 s. Its session cookie skips the check (about 0.2 s), so send the cookie
   * when we have it. A refused cookie (302/401/403) never reaches the runner, so one retry with the
   * token is safe. Only for bodies that can be sent twice (string or Buffer).
   */
  async function send(connection: Connection, phone: Owner, url: string, init: RequestInit & { headers: Headers }) {
    withKey(phone, init.headers);
    if (!connection.forwarded) return request(url, init);
    const cookie = connection.relayCookie;
    if (cookie) {
      const headers = new Headers(init.headers);
      headers.delete("X-Github-Token");
      headers.set("Cookie", cookie);
      const response = await request(url, { ...init, headers });
      if (![302, 401, 403].includes(response.status)) {
        connection.relayCookie = relayCookie(response) ?? cookie;
        return response;
      }
      await response.body?.cancel();
      if (connection.relayCookie === cookie) connection.relayCookie = undefined;
    }
    init.headers.set("X-Github-Token", await token(phone.userId));
    const response = await request(url, init);
    connection.relayCookie = relayCookie(response) ?? connection.relayCookie;
    return response;
  }
  return {
    close,
    async apps(phone: Owner, path: AppsPath, options: AppsRequest): Promise<Response> {
      if (!/^\/(?:apps(?:\/open)?|app-installs(?:\/[0-9a-f-]{36}(?:\/(?:content|complete|cancel))?)?|file-fetches(?:\/[0-9a-f-]{36}(?:\/cancel)?)?)$/.test(path)) throw new Error("Invalid Apps route");
      activity?.mark(phone);
      const { entry, release } = acquire(phone);
      try {
        const connection = await entry.connection;
        const headers = new Headers({ "content-type": options.bytes ? "application/octet-stream" : "application/json" });
        if (options.bytes) { headers.set("X-Upload-Offset", String(options.offset)); headers.set("X-Chunk-Sha256", options.digest ?? ""); }
        const signals = [entry.abort.signal, AbortSignal.timeout(90_000)];
        if (options.signal) signals.push(options.signal);
        const response = await send(connection, phone, `${connection.url}${path}`, { method: options.method, headers,
          body: options.bytes ? Buffer.from(options.bytes) : options.json ? JSON.stringify(options.json) : undefined,
          redirect: "manual", cache: "no-store", signal: AbortSignal.any(signals) });
        if (!response.headers.get("content-type")?.includes("application/json")) {
          await response.body?.cancel();
          return Response.json({ error: "runner_update_required", message: runnerUpdateMessage(phone.id, "Apps") }, { status: 503 });
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Empty Apps response");
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.length;
            if (size > 512 * 1024) { await reader.cancel(); throw new Error("Apps response too large"); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        return new Response(Buffer.concat(chunks), { status: response.status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
      } finally { release(); }
    },
    async adb(phone: Owner, input: AdbRequest): Promise<Response> {
      const { entry, release } = acquire(phone);
      let released = false;
      const done = () => { if (!released) { released = true; release(); } };
      try {
        const connection = await entry.connection;
        const files = input.files ?? [];
        const headers = new Headers({ "content-type": files.length ? "application/octet-stream" : "application/json" });
        if (input.key) headers.set("Idempotency-Key", input.key);
        // The runner writes these bytes to its own temp directory; it never receives a path.
        if (files.length) headers.set("X-Emuly-Adb", JSON.stringify({ args: input.args, timeout_s: input.timeout_s,
          binary: input.binary === true, files: files.map(file => ({ name: file.name, size: file.bytes.length })) }));
        const { key: _key, ...sent } = input;
        const body = files.length ? Buffer.concat(files.map(file => Buffer.from(file.bytes))) : JSON.stringify(sent);
        const response = await send(connection, phone, `${connection.url}/adb`, { method: "POST", headers, body,
          redirect: "manual", cache: "no-store",
          // A file upload shares the same deadline as the command it feeds.
          signal: AbortSignal.any([entry.abort.signal, AbortSignal.timeout(input.timeout_s * 1000
            + (input.files?.length ? 180_000 : 20_000))]) });
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Empty adb response");
        const type = response.headers.get("content-type") ?? "application/json";
        if (response.ok && !type.includes("application/json")) {
          // A pulled file or bugreport can pass the 4.5 MB Vercel response limit. Stream it, with the same cap.
          let sent = 0;
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { done: end, value } = await reader.read();
                if (end) { controller.close(); done(); return; }
                sent += value.length;
                if (sent > ADB_DOWNLOAD_MAX_BYTES) { await reader.cancel(); throw new Error("adb response too large"); }
                controller.enqueue(value);
              } catch (error) { controller.error(error); done(); }
            },
            cancel(reason) { done(); return reader.cancel(reason); },
          });
          const forwarded = new Headers({ "content-type": type, "cache-control": "private, no-store" });
          for (const name of ["content-length", "content-disposition"]) { const value = response.headers.get(name); if (value) forwarded.set(name, value); }
          return new Response(stream, { status: response.status, headers: forwarded });
        }
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.length;
            // JSON text can be larger than its decoded output; downloads have their own cap.
            if (size > ADB_DOWNLOAD_MAX_BYTES + 1024 * 1024) { await reader.cancel(); throw new Error("adb response too large"); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const relayed = new Headers({ "content-type": response.headers.get("content-type") ?? "application/json",
          "cache-control": "private, no-store" });
        const disposition = response.headers.get("content-disposition");
        if (disposition) relayed.set("content-disposition", disposition);
        done();
        return new Response(Buffer.concat(chunks), { status: response.status, headers: relayed });
      } catch (error) { done(); throw error; }
    },
    /** Raw relay for the agent-device proxy: both bodies stream, so nothing is buffered or parsed. */
    async proxy(phone: Owner, path: string, init: ProxyRequest): Promise<Response> {
      if (!path.startsWith("/agent-device/") || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("Invalid proxy route");
      activity?.mark(phone);
      const { entry, release } = acquire(phone);
      try {
        const connection = await entry.connection;
        const headers = withKey(phone, new Headers(init.headers));
        if (connection.forwarded) headers.set("X-Github-Token", await token(phone.userId));
        const signals = init.signal ? [entry.abort.signal, init.signal] : [entry.abort.signal];
        const response = await request(`${connection.url}${path}`, {
          method: init.method, headers, body: init.body ?? undefined,
          redirect: "manual", cache: "no-store", signal: AbortSignal.any(signals),
          // Node's fetch needs this for a streaming request body.
          duplex: init.body ? "half" : undefined,
        } as RequestInit & { duplex?: "half" });
        const relayed = new Headers({ "content-type": response.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store" });
        if (!response.body) { release(); return new Response(null, { status: response.status, headers: relayed }); }
        // Hold the connection lease until the CLI finishes reading, then return it to the idle timer.
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) { release(); controller.close(); return; }
              controller.enqueue(value);
            } catch (error) { release(); controller.error(error); }
          },
          async cancel(reason) { release(); await reader.cancel(reason).catch(() => {}); },
        });
        return new Response(body, { status: response.status, headers: relayed });
      } catch (error) {
        release();
        // A client walking away is not a tunnel failure; keep the reusable bridge for the next call.
        if (!init.signal?.aborted && entries.get(key(phone)) === entry) close(phone, "relay_failed");
        throw new Error("Phone connection failed. Try again.");
      }
    },
    async stream(phone: Owner) {
      const { entry, release } = acquire(phone);
      try {
        const connection = await entry.connection;
        const headers: Record<string, string> = withKey(phone, {});
        if (connection.forwarded) headers["X-Github-Token"] = await token(phone.userId);
        entry.abort.signal.throwIfAborted();
        entry.viewers++;
        // Opening the phone page is an action. Watching it with no input after that is not.
        activity?.mark(phone);
        observations?.mark(phone, "stream_attach", { count: entry.viewers });
        if (keepAwake && !entry.awake) {
          let pending = false;
          const coverageStarted = Date.now();
          let lastSuccess = 0, gap = false, expected = coverageStarted, consecutiveFailures = 0;
          observations?.mark(phone, "awake_timer_start", { count: entry.viewers, retryDelayMs: 60000 });
          const pulse = async () => {
            const scheduledAt = new Date(expected).toISOString(); expected += 60000;
            if (Date.now() - (lastSuccess || coverageStarted) >= 120000 && !gap) {
              gap = true;
              observations?.mark(phone, "coverage_gap", { outcome: "unknown", errorCode: "coverage_missing" });
            }
            if (pending || entry.abort.signal.aborted || !entry.viewers) {
              observations?.mark(phone, "keep_awake", { outcome: "skipped", scheduledAt, count: entry.viewers,
                errorCode: pending ? "already_pending" : entry.abort.signal.aborted ? "connection_aborted" : "no_viewers" });
              return;
            }
            pending = true;
            let secret = "";
            // An open tab with no input must not keep the phone awake past its idle time.
            if (activity && !(await activity.recent(phone).catch(() => true))) {
              observations?.mark(phone, "keep_awake", { outcome: "skipped", scheduledAt, count: entry.viewers, errorCode: "no_activity" });
              pending = false;
              return;
            }
            try {
              const work = () => measure("keep_awake", async () => {
                secret = await measure("credential_lookup", () => token(phone.userId));
                if (entry.abort.signal.aborted || !entry.viewers) {
                  observations?.mark(phone, "keep_awake", { outcome: "skipped", errorCode: "connection_aborted" });
                  return;
                }
                const result = await keepAwake(secret, phone.codespaceName);
                if (result && typeof result === "object" && "code" in result && result.code !== 0) throw new Error("Keep-awake command failed");
                lastSuccess = Date.now();
                entry.lastAwakeSuccess = lastSuccess;
                consecutiveFailures = 0;
                if (gap) { gap = false; observations?.mark(phone, "coverage_recovered"); }
              }, { scheduledAt, count: entry.viewers, retryDelayMs: 60000, consecutiveFailures,
                ...(lastSuccess ? { sinceSuccessMs: Math.min(86400000, Date.now() - lastSuccess) } : {}) });
              await (observations ? observations.scope(phone, work) : work());
            } catch (error) {
              consecutiveFailures++;
              // A failed keep-awake must not interrupt the video. Log only the redacted error, never the token.
              streamLog("keep_awake_failed", { phone: phone.id, viewers: entry.viewers,
                awake_ms: lastSuccess ? Date.now() - lastSuccess : "none", error: safeErrorText(error, secret) });
            }
            finally { pending = false; }
          };
          entry.awake = setInterval(() => { void pulse(); }, 60_000);
          entry.awake.unref();
          void pulse();
        }
        let released = false;
        const releaseStream = () => {
          if (released) return;
          released = true;
          observations?.mark(phone, "stream_detach", { count: Math.max(0, entry.viewers - 1) });
          if (--entry.viewers === 0) {
            clearInterval(entry.awake); entry.awake = undefined;
            observations?.mark(phone, "awake_timer_stop", { count: 0, errorCode: "no_viewers" });
          }
          release();
        };
        return { url: connection.url.replace(/^http/, "ws") + "/stream", headers, signal: entry.abort.signal, release: releaseStream,
          // The proxy needs to report which transport carried the stream and drop this bridge when GitHub stops the phone.
          route: connection.forwarded ? "forwarded" as const : "tunnel" as const,
          get viewers() { return entry.viewers; },
          get lastAwakeSuccess() { return entry.lastAwakeSuccess; },
          drop() { if (entries.get(key(phone)) === entry) close(phone, "stream_dropped"); },
          acceptedInput() { observations?.input(phone); activity?.mark(phone); },
          failed() { if (connection.forwarded && entries.get(key(phone)) === entry) { close(phone, "stream_failed"); streamFallback.add(key(phone)); } } };
      } catch { release(); if (entries.get(key(phone)) === entry) close(phone, "stream_open_failed"); throw new Error("Stream unavailable"); }
    },
    /** Link and net-check calls. The runner's status and JSON error reach the caller unchanged. */
    async links(phone: Owner, path: LinksPath, body?: Record<string, unknown>): Promise<Response> {
      if (!["/links", "/links/remove", "/net-check", "/link-hints", "/egress", "/egress/check"].includes(path)) throw new Error("Invalid links route");
      // Reading the list is not an action: an open console tab polls it and must not keep the phone awake.
      if (body) activity?.mark(phone);
      const { entry, release } = acquire(phone);
      try {
        const connection = await entry.connection;
        const headers = new Headers({ "content-type": "application/json" });
        const response = await send(connection, phone, `${connection.url}${path}`, { method: body ? "POST" : "GET", headers,
          body: body ? JSON.stringify(body) : undefined, redirect: "manual", cache: "no-store",
          signal: AbortSignal.any([entry.abort.signal, AbortSignal.timeout(40_000)]) });
        const bytes = await response.arrayBuffer();
        if (!response.headers.get("content-type")?.includes("application/json")) {
          return Response.json({ error: "runner_update_required", message: runnerUpdateMessage(phone.id, "Links") }, { status: 503 });
        }
        return new Response(bytes, { status: response.status, headers: { "content-type": "application/json" } });
      } finally { release(); }
    },
    /**
     * Screen recording calls (phone/runner/recording.mjs). JSON replies keep the runner's status.
     * "file" streams the MP4 through without buffering it, and holds the lease until the body ends,
     * so the idle timer does not close the bridge during a long download.
     */
    async recording(phone: Owner, action: RecordingAction, body?: Record<string, unknown>): Promise<Response> {
      const routes: Record<RecordingAction, [string, string]> = { start: ["POST", "/recording/start"], stop: ["POST", "/recording/stop"],
        discard: ["POST", "/recording/discard"], status: ["GET", "/recording"], file: ["GET", "/recording/file"], grid: ["GET", "/recording/grid"],
        mark: ["POST", "/recording/mark"], notes: ["GET", "/recording/notes"] };
      const [method, route] = routes[action];
      // grid sends its options (fps, cols, width, count, page) as the query.
      const path = action === "grid" && body ? `${route}?${new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))}` : route;
      if (action === "start" || action === "stop") activity?.mark(phone);
      const { entry, release } = acquire(phone);
      let released = false;
      const done = () => { if (!released) { released = true; release(); } };
      try {
        const connection = await entry.connection;
        const headers = new Headers({ "content-type": "application/json" });
        const response = await send(connection, phone, `${connection.url}${path}`, { method, headers,
          body: method === "POST" ? JSON.stringify(body ?? {}) : undefined, redirect: "manual", cache: "no-store",
          // A 30-minute recording is up to ~1 GB; the download gets 10 minutes, every other call 40 s.
          signal: AbortSignal.any([entry.abort.signal, AbortSignal.timeout(action === "file" ? 600_000 : action === "grid" ? 120_000 : 40_000)]) });
        const type = response.headers.get("content-type") ?? "";
        if (action === "file" && response.ok && type.startsWith("video/mp4") && response.body) {
          const reader = response.body.getReader();
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { done: end, value } = await reader.read();
                if (end) { controller.close(); done(); } else controller.enqueue(value);
              } catch (error) { controller.error(error); done(); }
            },
            cancel(reason) { done(); return reader.cancel(reason); },
          });
          const forwarded = new Headers({ "content-type": "video/mp4" });
          for (const name of ["content-length", "content-disposition"]) { const value = response.headers.get(name); if (value) forwarded.set(name, value); }
          return new Response(stream, { status: 200, headers: forwarded });
        }
        const bytes = await response.arrayBuffer();
        done();
        if (action === "grid" && response.ok && type.startsWith("image/jpeg")) {
          const forwarded = new Headers({ "content-type": "image/jpeg" });
          for (const [name, value] of response.headers) if (name.startsWith("x-grid-")) forwarded.set(name, value);
          return new Response(bytes, { status: 200, headers: forwarded });
        }
        if (!type.includes("application/json")) {
          return Response.json({ error: "runner_update_required", message: runnerUpdateMessage(phone.id, "Recording") }, { status: 503 });
        }
        return new Response(bytes, { status: response.status, headers: { "content-type": "application/json" } });
      } catch (error) { done(); throw error; }
    },
    /** The runner end of a relay websocket. The caller opens it and calls release() when it closes. */
    async relay(phone: Owner, ports: number[]) {
      const { entry, release } = acquire(phone);
      try {
        const connection = await entry.connection;
        const headers: Record<string, string> = withKey(phone, {});
        if (connection.forwarded) headers["X-Github-Token"] = await token(phone.userId);
        entry.abort.signal.throwIfAborted();
        activity?.mark(phone);
        return { url: `${connection.url.replace(/^http/, "ws")}/links/relay?ports=${ports.join(",")}`, headers,
          signal: entry.abort.signal, release };
      } catch (error) { release(); throw error; }
    },
    /** query is only for GET /screenshot (scale) and GET /ui (all). */
    async request(phone: Owner, path: RunnerPath, body?: Record<string, unknown>, query?: Record<string, string>): Promise<Response> {
      if (!/^[\w-]{1,100}$/.test(phone.codespaceName)) throw new Error("Invalid codespace name");
      if (!["/health", "/boot", "/stop", "/screenshot", "/ui", "/tap", "/key", "/agent-device-info", "/direct/revoke"].includes(path)) throw new Error("Invalid runner route");
      const { entry, release } = acquire(phone);
      try {
        const connection = await entry.connection;
        const headers = new Headers({ "content-type": "application/json" });
        const search = query && (path === "/screenshot" || path === "/ui") ? `?${new URLSearchParams(query)}` : "";
        const response = await send(connection, phone, `${connection.url}${path}${search}`, { method: body ? "POST" : "GET", headers,
          body: body ? JSON.stringify(body) : undefined, redirect: "manual", cache: "no-store",
          signal: AbortSignal.any([entry.abort.signal, AbortSignal.timeout(path === "/boot" ? BOOT_REQUEST_MS : path === "/stop" ? 180_000 : 20_000)]) });
        // Consume before releasing the lease: a slow image must not lose its bridge to the idle timer.
        const bytes = await response.arrayBuffer();
        // /ui errors are JSON with a hint for the agent (ui-tree.mjs): pass them through.
        const jsonError = path === "/ui" && response.headers.get("content-type")?.includes("application/json");
        if (!response.ok && !jsonError) throw new RunnerResponseError(`Runner ${path} returned ${response.status}.`);
        if (path === "/tap" || path === "/key") { observations?.input(phone); activity?.mark(phone); }
        const forwarded: Record<string, string> = { "content-type": response.headers.get("content-type") ?? "application/json" };
        const scale = response.headers.get("x-screenshot-scale");
        if (scale) forwarded["x-screenshot-scale"] = scale;
        return new Response(bytes, { status: response.status, headers: forwarded });
      } catch (error) {
        // Log the kind of failure (timeout, abort, network code, HTTP status) without any runner output.
        const cause = error instanceof Error ? (error as Error & { cause?: { code?: string } }).cause?.code : undefined;
        console.error(`[runner] ${phone.codespaceName} ${path} failed:`, error instanceof RunnerResponseError ? error.message
          : error instanceof Error ? `${error.name}${cause ? ` (${cause})` : ""}` : "unknown");
        // A timeout means the phone was slow (a screenshot during boot can take >20 s), not that the
        // connection is dead. Closing it would stop every viewer's video. A dead connection fails
        // the video stream too, and the stream closes it.
        const slow = error instanceof Error && error.name === "TimeoutError";
        if (!(error instanceof RunnerResponseError) && !slow && entries.get(key(phone)) === entry) close(phone, `request_failed:${path}`);
        if (slow) throw new RunnerTimeoutError(`The phone did not answer ${path} in time. It is often slow just after boot.`);
        throw new Error(`Phone connection failed (${path}). Try again.`);
      } finally {
        release();
      }
    },
  };
}
