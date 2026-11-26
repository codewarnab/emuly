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
/** Claim a free or expired lease for 120 s. True when this owner now holds it. */
export async function claimLease(database: DatabaseQueries, resource: string, owner: string) {
  const claim = await database.execute({ sql: `INSERT INTO coordination_leases (resource, owner, expires_at)
    VALUES (?, ?, ${now} + 120000) ON CONFLICT(resource) DO UPDATE SET owner = excluded.owner,
    expires_at = excluded.expires_at WHERE coordination_leases.expires_at <= ${now}`, args: [resource, owner] });
  return claim.rowsAffected > 0;
}
/** Extend a held lease by 120 s. False when the lease expired or another owner took it. */
export async function renewLease(database: DatabaseQueries, resource: string, owner: string) {
  const result = await database.execute({ sql: `UPDATE coordination_leases SET expires_at = ${now} + 120000
    WHERE resource = ? AND owner = ? AND expires_at > ${now}`, args: [resource, owner] });
  return result.rowsAffected > 0;
}
export async function releaseLease(database: DatabaseQueries, resource: string, owner: string) {
  await database.execute({ sql: "DELETE FROM coordination_leases WHERE resource = ? AND owner = ?", args: [resource, owner] });
}
export async function withLease<T>(database: DatabaseQueries, resource: string, work: () => Promise<T>, waitMs = 0): Promise<T> {
  const owner = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await claimLease(database, resource, owner)) break;
    if (Date.now() >= deadline) throw new CoordinationBusyError();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  let lost = false;
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (!(await renewLease(database, resource, owner))) lost = true;
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
    await releaseLease(database, resource, owner);
  }
}

/** True when any owner holds an unexpired lease on `resource`. */
export async function leaseHeld(database: DatabaseQueries, resource: string) {
  const row = await database.execute({ sql: `SELECT 1 FROM coordination_leases WHERE resource = ? AND expires_at > ${now}`, args: [resource] });
  return row.rows.length > 0;
}

export type HeldLease = {
  release: () => Promise<void>;
  /** Renews now. Throws CoordinationBusyError when a renewal failed or the lease expired, so the caller stops before a provider call. */
  assertHeld: () => Promise<void>;
};
/**
 * Claims `resource` without waiting and renews it every 20 s until `release`. Null when another
 * owner holds it. Unlike `withLease`, the caller may hand the lease to background work, which
 * then releases it. A process that dies leaves the lease to expire after 120 s.
 */
export async function holdLease(database: DatabaseQueries, resource: string): Promise<HeldLease | null> {
  const owner = randomUUID();
  if (!(await claimLease(database, resource, owner))) return null;
  // A failed or refused renewal marks the lease lost. Another request may claim it after 120 s.
  let lost = false;
  const timer = setInterval(() => {
    void renewLease(database, resource, owner).then(held => { if (!held) lost = true; }, () => { lost = true; });
  }, 20_000);
  timer.unref();
  let released = false;
  return {
    async assertHeld() {
      if (lost || released || !(await renewLease(database, resource, owner))) { lost = true; throw new CoordinationBusyError(); }
    },
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await releaseLease(database, resource, owner);
    },
  };
}
