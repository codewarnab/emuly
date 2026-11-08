import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseQueries } from "./async-database.ts";

export class CoordinationBusyError extends Error {
  constructor() { super("Another request is already in progress. Try again shortly."); }
}

/** Database time avoids clock skew between application instances. */
const now = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const scope = new AsyncLocalStorage<{ resource: string; owner: string }[]>();
export function independentWork<T>(work: () => Promise<T>) { return scope.run([], work); }
export async function assertCoordination(queries: DatabaseQueries) {
  for (const lease of scope.getStore() ?? []) {
    const row = await queries.execute({ sql: `SELECT 1 FROM coordination_leases WHERE resource = ? AND owner = ? AND expires_at > ${now}`,
      args: [lease.resource, lease.owner] });
    if (!row.rows.length) throw new CoordinationBusyError();
  }
}
export async function withLease<T>(database: DatabaseQueries, resource: string, work: () => Promise<T>, waitMs = 0): Promise<T> {
  const owner = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const claim = await database.execute({ sql: `INSERT INTO coordination_leases (resource, owner, expires_at)
      VALUES (?, ?, ${now} + 120000) ON CONFLICT(resource) DO UPDATE SET owner = excluded.owner,
      expires_at = excluded.expires_at WHERE coordination_leases.expires_at <= ${now}`, args: [resource, owner] });
    if (claim.rowsAffected) break;
    if (Date.now() >= deadline) throw new CoordinationBusyError();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  let lost = false;
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      const result = await database.execute({ sql: `UPDATE coordination_leases SET expires_at = ${now} + 120000
        WHERE resource = ? AND owner = ? AND expires_at > ${now}`, args: [resource, owner] });
      if (!result.rowsAffected) lost = true;
    }).catch(() => { lost = true; });
  }, 20_000);
  timer.unref();
  try {
    return await scope.run([...(scope.getStore() ?? []), { resource, owner }], async () => {
      const result = await work();
      await renewal;
      if (lost) throw new CoordinationBusyError();
      await assertCoordination(database);
      return result;
    });
  } finally {
    clearInterval(timer);
    await renewal;
    await database.execute({ sql: "DELETE FROM coordination_leases WHERE resource = ? AND owner = ?", args: [resource, owner] });
  }
}
