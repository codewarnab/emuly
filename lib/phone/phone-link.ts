import "server-only";
import { measure } from "../diagnostics/diagnostics.ts";
import { ADB_DOWNLOAD_MAX_BYTES } from "./phone-adb-contract.ts";
import type { phoneObservations } from "./phone-observation.ts";

type Bridge = { url: string; close: () => void };
type Owner = { userId: number; id: string; codespaceName: string };
type Connection = Bridge & { forwarded: boolean };
type Entry = { connection: Promise<Connection>; abort: AbortController; active: number; viewers: number; timer?: NodeJS.Timeout; awake?: NodeJS.Timeout };
class RunnerResponseError extends Error {}
export type RunnerPath = "/health" | "/boot" | "/stop" | "/screenshot" | "/tap" | "/key" | "/agent-device-info";
export type AppsPath = "/apps" | "/apps/open" | "/app-installs" | `/app-installs/${string}`;
export type AppsRequest = { method: "GET" | "POST" | "PUT"; json?: Record<string, unknown>; bytes?: Uint8Array; offset?: number; digest?: string; signal?: AbortSignal };
export type AdbRequest = { args: string[]; timeout_s: number; binary?: boolean; files?: { name: string; bytes: Uint8Array }[] };
export type ProxyRequest = { method: string; headers: Headers; body?: ReadableStream<Uint8Array> | null; signal?: AbortSignal };

/** One connection per owned phone. Only a read-only probe may fall back; never replay a mutation. */
export function createEmulyLinks({ token, tunnel, keepAwake, observations, fetch: request = fetch, idleMs = 120_000 }: {
  token: (userId: number) => Promise<string>;
  tunnel: (token: string, name: string, signal: AbortSignal) => Promise<Bridge>;
  keepAwake?: (token: string, name: string) => Promise<unknown>;
  fetch?: typeof fetch;
  idleMs?: number;
  observations?: ReturnType<typeof phoneObservations>;
}) {
  const entries = new Map<string, Entry>();
  const streamFallback = new Set<string>();
  const key = (phone: Owner) => `${phone.userId}:${phone.id}:${phone.codespaceName}`;
  const close = (phone: Owner) => {
    const entry = entries.get(key(phone));
    if (!entry) return;
    entries.delete(key(phone));
    clearTimeout(entry.timer);
    clearInterval(entry.awake);
    if (entry.awake) observations?.mark(phone, "awake_timer_stop", { count: entry.viewers, errorCode: "observer_shutdown" });
    entry.abort.abort();
    void entry.connection.then(connection => connection.close(), () => {});
  };
  async function connect(phone: Owner, signal: AbortSignal): Promise<Connection> {
    const secret = await measure("credential_lookup", () => token(phone.userId));
    const url = `https://${phone.codespaceName}-8790.app.github.dev`;
    const forceTunnel = streamFallback.delete(key(phone));
    try {
      if (forceTunnel) throw new Error("WebSocket forwarding unavailable");
      const probe = await measure("forwarded_probe", () => request(`${url}/health`, { headers: { "X-Github-Token": secret },
        redirect: "manual", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }), { route: "forwarded" });
      if (probe.ok && probe.headers.get("content-type")?.includes("application/json") && (await probe.json()).ok === true) {
        return { url, forwarded: true, close() {} };
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
        entry.timer = setTimeout(() => { if (entries.get(key(phone)) === entry) close(phone); }, idleMs);
        entry.timer.unref();
      }
    } };
  }
  return {
    close,
    async apps(phone: Owner, path: AppsPath, options: AppsRequest): Promise<Response> {
      if (!/^\/(?:apps(?:\/open)?|app-installs(?:\/[0-9a-f-]{36}(?:\/(?:content|complete|cancel))?)?)$/.test(path)) throw new Error("Invalid Apps route");
      const { entry, release } = acquire(phone);
      try {
        const connection = await entry.connection;
        const headers = new Headers({ "content-type": options.bytes ? "application/octet-stream" : "application/json" });
        if (connection.forwarded) headers.set("X-Github-Token", await token(phone.userId));
        if (options.bytes) { headers.set("X-Upload-Offset", String(options.offset)); headers.set("X-Chunk-Sha256", options.digest ?? ""); }
        const signals = [entry.abort.signal, AbortSignal.timeout(90_000)];
        if (options.signal) signals.push(options.signal);
        const response = await request(`${connection.url}${path}`, { method: options.method, headers,
          body: options.bytes ? Buffer.from(options.bytes) : options.json ? JSON.stringify(options.json) : undefined,
          redirect: "manual", cache: "no-store", signal: AbortSignal.any(signals) });
        if (!response.headers.get("content-type")?.includes("application/json")) {
          await response.body?.cancel();
          return Response.json({ error: "Update the phone runner before using Apps.", errorCode: "runner_update_required" }, { status: 503 });
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
      try {
        const connection = await entry.connection;
        const files = input.files ?? [];
        const headers = new Headers({ "content-type": files.length ? "application/octet-stream" : "application/json" });
        if (connection.forwarded) headers.set("X-Github-Token", await token(phone.userId));
        // The runner writes these bytes to its own temp directory; it never receives a path.
        if (files.length) headers.set("X-Emuly-Adb", JSON.stringify({ args: input.args, timeout_s: input.timeout_s,
          binary: input.binary === true, files: files.map(file => ({ name: file.name, size: file.bytes.length })) }));
        const body = files.length ? Buffer.concat(files.map(file => Buffer.from(file.bytes))) : JSON.stringify(input);
        const response = await request(`${connection.url}/adb`, { method: "POST", headers, body,
          redirect: "manual", cache: "no-store",
          // A file upload shares the same deadline as the command it feeds.
          signal: AbortSignal.any([entry.abort.signal, AbortSignal.timeout(input.timeout_s * 1000
            + (input.files?.length ? 180_000 : 20_000))]) });
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Empty adb response");
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
        return new Response(Buffer.concat(chunks), { status: response.status, headers: relayed });
      } finally { release(); }
    },
    /** Raw relay for the agent-device proxy: both bodies stream, so nothing is buffered or parsed. */
    async proxy(phone: Owner, path: string, init: ProxyRequest): Promise<Response> {
      if (!path.startsWith("/agent-device/") || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("Invalid proxy route");
      const { entry, release } = acquire(phone);
      try {
        const connection = await entry.connection;
        const headers = new Headers(init.headers);
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
        if (!init.signal?.aborted && entries.get(key(phone)) === entry) close(phone);
        throw new Error("Phone connection failed. Try again.");
      }
    },
    async stream(phone: Owner) {
      const { entry, release } = acquire(phone);
      try {
        const connection = await entry.connection;
        const headers: Record<string, string> = {};
        if (connection.forwarded) headers["X-Github-Token"] = await token(phone.userId);
        entry.abort.signal.throwIfAborted();
        entry.viewers++;
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
            try {
              const work = () => measure("keep_awake", async () => {
                const secret = await measure("credential_lookup", () => token(phone.userId));
                if (entry.abort.signal.aborted || !entry.viewers) {
                  observations?.mark(phone, "keep_awake", { outcome: "skipped", errorCode: "connection_aborted" });
                  return;
                }
                const result = await keepAwake(secret, phone.codespaceName);
                if (result && typeof result === "object" && "code" in result && result.code !== 0) throw new Error("Keep-awake command failed");
                lastSuccess = Date.now();
                consecutiveFailures = 0;
                if (gap) { gap = false; observations?.mark(phone, "coverage_recovered"); }
              }, { scheduledAt, count: entry.viewers, retryDelayMs: 60000, consecutiveFailures,
                ...(lastSuccess ? { sinceSuccessMs: Math.min(86400000, Date.now() - lastSuccess) } : {}) });
              await (observations ? observations.scope(phone, work) : work());
            } catch { consecutiveFailures++; /* A failed keep-awake must not interrupt the video. */ }
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
          acceptedInput() { observations?.input(phone); },
          failed() { if (connection.forwarded && entries.get(key(phone)) === entry) { close(phone); streamFallback.add(key(phone)); } } };
      } catch { release(); if (entries.get(key(phone)) === entry) close(phone); throw new Error("Stream unavailable"); }
    },
    async request(phone: Owner, path: RunnerPath, body?: Record<string, unknown>): Promise<Response> {
      if (!/^[\w-]{1,100}$/.test(phone.codespaceName)) throw new Error("Invalid codespace name");
      if (!["/health", "/boot", "/stop", "/screenshot", "/tap", "/key", "/agent-device-info"].includes(path)) throw new Error("Invalid runner route");
      const { entry, release } = acquire(phone);
      try {
        const connection = await entry.connection;
        const headers = new Headers({ "content-type": "application/json" });
        if (connection.forwarded) headers.set("X-Github-Token", await token(phone.userId));
        const response = await request(`${connection.url}${path}`, { method: body ? "POST" : "GET", headers,
          body: body ? JSON.stringify(body) : undefined, redirect: "manual", cache: "no-store",
          signal: AbortSignal.any([entry.abort.signal, AbortSignal.timeout(path === "/boot" ? 1_200_000 : path === "/stop" ? 180_000 : 20_000)]) });
        // Consume before releasing the lease: a slow image must not lose its bridge to the idle timer.
        const bytes = await response.arrayBuffer();
        if (!response.ok) throw new RunnerResponseError(`Runner ${path} returned ${response.status}.`);
        if (path === "/tap" || path === "/key") observations?.input(phone);
        return new Response(bytes, { headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
      } catch (error) {
        if (!(error instanceof RunnerResponseError) && entries.get(key(phone)) === entry) close(phone);
        throw new Error(`Phone connection failed (${path}). Try again.`);
      } finally {
        release();
      }
    },
  };
}
