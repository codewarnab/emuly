import "server-only";

type Bridge = { url: string; close: () => void };
type Owner = { userId: number; id: string; codespaceName: string };
type Connection = Bridge & { forwarded: boolean };
type Entry = { connection: Promise<Connection>; abort: AbortController; active: number; viewers: number; timer?: NodeJS.Timeout; awake?: NodeJS.Timeout };
class RunnerResponseError extends Error {}
export type RunnerPath = "/health" | "/boot" | "/stop" | "/screenshot" | "/tap" | "/key";

/** One connection per owned phone. Only a read-only probe may fall back; never replay a mutation. */
export function createPhoneLinks({ token, tunnel, keepAwake, fetch: request = fetch, idleMs = 120_000 }: {
  token: (userId: number) => Promise<string>;
  tunnel: (token: string, name: string, signal: AbortSignal) => Promise<Bridge>;
  keepAwake?: (token: string, name: string) => Promise<unknown>;
  fetch?: typeof fetch;
  idleMs?: number;
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
    entry.abort.abort();
    void entry.connection.then(connection => connection.close(), () => {});
  };
  async function connect(phone: Owner, signal: AbortSignal): Promise<Connection> {
    const secret = await token(phone.userId);
    const url = `https://${phone.codespaceName}-8790.app.github.dev`;
    const forceTunnel = streamFallback.delete(key(phone));
    try {
      if (forceTunnel) throw new Error("WebSocket forwarding unavailable");
      const probe = await request(`${url}/health`, { headers: { "X-Github-Token": secret },
        redirect: "manual", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
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
      const opening = connect(phone, abort.signal).then(connection => {
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
    async stream(phone: Owner) {
      const { entry, release } = acquire(phone);
      try {
        const connection = await entry.connection;
        const headers: Record<string, string> = {};
        if (connection.forwarded) headers["X-Github-Token"] = await token(phone.userId);
        entry.abort.signal.throwIfAborted();
        entry.viewers++;
        if (keepAwake && !entry.awake) {
          let pending = false;
          const pulse = async () => {
            if (pending || entry.abort.signal.aborted || !entry.viewers) return;
            pending = true;
            try {
              const secret = await token(phone.userId);
              if (!entry.abort.signal.aborted && entry.viewers) await keepAwake(secret, phone.codespaceName);
            } catch { /* A failed keep-awake must not interrupt the video. */ }
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
          if (--entry.viewers === 0) { clearInterval(entry.awake); entry.awake = undefined; }
          release();
        };
        return { url: connection.url.replace(/^http/, "ws") + "/stream", headers, signal: entry.abort.signal, release: releaseStream,
          failed() { if (connection.forwarded && entries.get(key(phone)) === entry) { close(phone); streamFallback.add(key(phone)); } } };
      } catch { release(); if (entries.get(key(phone)) === entry) close(phone); throw new Error("Stream unavailable"); }
    },
    async request(phone: Owner, path: RunnerPath, body?: Record<string, unknown>): Promise<Response> {
      if (!/^[\w-]{1,100}$/.test(phone.codespaceName)) throw new Error("Invalid codespace name");
      if (!["/health", "/boot", "/stop", "/screenshot", "/tap", "/key"].includes(path)) throw new Error("Invalid runner route");
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
