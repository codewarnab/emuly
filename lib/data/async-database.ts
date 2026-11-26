import { createClient as libsqlClient, type Client, type Config, type InStatement, type ResultSet } from "@libsql/client";
import { assertCoordination } from "./coordination.ts";

/** Both root clients and transaction handles expose this same query boundary. */
export type DatabaseQueries = { execute(statement: InStatement): Promise<ResultSet> };

const transactions = new WeakMap<Client, Promise<unknown>>();

/** A transaction that runs longer than this is rolled back, so it cannot block later writers forever. */
export const TRANSACTION_TIMEOUT_MS = 15_000;

/**
 * Pass the supplied handle to every helper; never use the root client inside work.
 * Only local file: SQLite runs transactions one at a time in this process. Turso serializes writes itself,
 * and other Vercel instances already write at the same time, so a remote transaction starts at once and
 * one slow user does not make the other users on a Fluid instance wait.
 */
export async function transaction<T>(client: Client, work: (queries: DatabaseQueries) => Promise<T>,
  timeoutMs = TRANSACTION_TIMEOUT_MS): Promise<T> {
  if (client.protocol !== "file") return performTransaction(client, work, timeoutMs);
  const previous = transactions.get(client) ?? Promise.resolve();
  const result = previous.then(() => performTransaction(client, work, timeoutMs));
  transactions.set(client, result.catch(() => {}));
  return result;
}

/** A transaction passed its time limit and rolled back. Work after this point must not run. */
export class TransactionTimeoutError extends Error {
  readonly code = "TRANSACTION_TIMEOUT";
  constructor(timeoutMs: number) { super(`Transaction took longer than ${timeoutMs} ms`); this.name = "TransactionTimeoutError"; }
}

const busyError = (error: unknown) => /SQLITE_BUSY|database is locked/i.test(String((error as { code?: unknown })?.code ?? "") + " " + String((error as Error)?.message ?? ""));

async function performTransaction<T>(client: Client, work: (queries: DatabaseQueries) => Promise<T>, timeoutMs: number): Promise<T> {
  // The limit covers the wait for the write lock too. A busy writer is retried until then.
  const deadline = Date.now() + timeoutMs;
  let tx: Awaited<ReturnType<Client["transaction"]>>;
  for (let delay = 25; ; delay = Math.min(delay * 2, 500)) {
    try { tx = await client.transaction("write"); break; }
    catch (error) {
      if (!busyError(error)) throw error;
      if (Date.now() + delay >= deadline) throw new TransactionTimeoutError(timeoutMs);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new TransactionTimeoutError(timeoutMs)); }, Math.max(0, deadline - Date.now()));
  });
  // After the limit, every statement of the abandoned work fails at once, so its later steps stop.
  const guarded: DatabaseQueries = new Proxy(tx, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      if (timedOut) return Promise.reject(new TransactionTimeoutError(timeoutMs));
      return value.apply(target, args);
    };
  } });
  try {
    await assertCoordination(tx);
    const result = await Promise.race([work(guarded), timeout]);
    await assertCoordination(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try { await tx.rollback(); } catch { /* Preserve the operation's original error. */ }
    throw error;
  } finally { clearTimeout(timer); tx.close(); }
}

/** Local SQLite cannot wait on a second writer while its first writer awaits JS.
 * Queue root operations until an interactive transaction releases its connection.
 * Transaction handles execute directly; remote clients use the provider's pool.
 */
export function createClient(config: Config): Client {
  const client = libsqlClient(config);
  if (!config.url.startsWith("file:")) return client;
  let pending = Promise.resolve();
  async function acquire() {
    const previous = pending;
    let release!: () => void;
    pending = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  }
  const queued = new Set(["execute", "batch", "executeMultiple", "migrate", "sync"]);
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "transaction") return async (...args: Parameters<Client["transaction"]>) => {
        const release = await acquire();
        try {
          const tx = await target.transaction(...args);
          return new Proxy(tx, {
            get(handle, method) {
              const member = Reflect.get(handle, method, handle);
              if (method === "close") return () => { try { handle.close(); } finally { release(); } };
              if (method === "commit" || method === "rollback") return async () => {
                try { return await member.call(handle); } finally { release(); }
              };
              return typeof member === "function" ? member.bind(handle) : member;
            },
          });
        } catch (error) { release(); throw error; }
      };
      if (typeof key === "string" && queued.has(key)) return async (...args: unknown[]) => {
        const release = await acquire();
        try { return await value.apply(target, args); } finally { release(); }
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
