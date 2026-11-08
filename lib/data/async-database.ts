import { createClient as libsqlClient, type Client, type Config, type InStatement, type ResultSet } from "@libsql/client";

/** Both root clients and transaction handles expose this same query boundary. */
export type DatabaseQueries = { execute(statement: InStatement): Promise<ResultSet> };

const transactions = new WeakMap<Client, Promise<unknown>>();

/** Pass the supplied handle to every helper; never use the root client inside work. */
export async function transaction<T>(client: Client, work: (queries: DatabaseQueries) => Promise<T>): Promise<T> {
  const previous = transactions.get(client) ?? Promise.resolve();
  const result = previous.then(() => performTransaction(client, work));
  transactions.set(client, result.catch(() => {}));
  return result;
}

async function performTransaction<T>(client: Client, work: (queries: DatabaseQueries) => Promise<T>): Promise<T> {
  const tx = await client.transaction("write");
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try { await tx.rollback(); } catch { /* Preserve the operation's original error. */ }
    throw error;
  } finally { tx.close(); }
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
