import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { claimLease, releaseLease, renewLease } from "../data/coordination.ts";
import { recordSchedulerRun } from "./scheduler-health.ts";

/** How often the scheduler syncs one user with GitHub, from the states of that user's phones. */
export const SYNC_TIERS = {
  /** A phone changes state now (creating, booting, stopping, or Android boots). */
  busyMs: 10_000,
  /** A phone runs. GitHub can stop it (its own idle timer, the 12 h limit, the GitHub UI). */
  runningMs: 60_000,
  /** All phones are stopped. Only GitHub retention can change them. A page visit still syncs at once. */
  stoppedMs: 30 * 60_000,
} as const;

export const LOOP_MS = { fast: 5_000, sync: 5_000, minute: 60_000, runner: 60_000, hourly: 60 * 60_000 } as const;
/** The lease of /api/cron, so the old cron and this scheduler never run at the same time. */
export const SCHEDULER_LEASE = "scheduled:reconcile";

type PhoneState = { state: string; android_state: string | null };

/** The sync interval for one user. */
export function syncIntervalFor(phones: PhoneState[]) {
  const busy = phones.some(phone => ["pending", "creating", "booting", "starting", "stopping"].includes(phone.state)
    || (phone.state === "running" && ["idle", "booting", "stopping"].includes(phone.android_state ?? "")));
  if (busy) return SYNC_TIERS.busyMs;
  if (phones.some(phone => phone.state === "running")) return SYNC_TIERS.runningMs;
  return SYNC_TIERS.stoppedMs;
}

/** The users whose sync is due now, most urgent first. syncedAt is the last finished sync from any caller. */
export function dueUsers(users: { userId: number; phones: PhoneState[]; syncedAt: number | null }[], now: number) {
  return users.map(user => ({ ...user, interval: syncIntervalFor(user.phones) }))
    .filter(user => user.syncedAt === null || now - user.syncedAt >= user.interval)
    .sort((a, b) => a.interval - b.interval || (a.syncedAt ?? 0) - (b.syncedAt ?? 0))
    .map(user => user.userId);
}

/** Run work for each item, at most `limit` at a time. One failure does not stop the others. */
export async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<unknown>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try { await work(item); } catch { /* The work records its own failure. */ }
    }
  });
  await Promise.all(workers);
}

export type SchedulerParts = {
  /** GitHub sync for one user. It throws on failure. */
  sync: (userId: number) => Promise<void>;
  backoffLeft: (userId: number) => Promise<number>;
  clearBackoff: (userId: number) => Promise<void>;
  backOff: (userId: number, error: unknown) => Promise<void>;
  protectBudget: (userId: number) => Promise<void>;
  protectRetention: (userId: number) => Promise<void>;
  /** Diagnostics, deleted-phone purge, idle warning and idle stop. */
  minute: () => Promise<void>;
  /** Webhook delivery. */
  deliver: () => Promise<void>;
  /** In-place runner update of running phones (runner-update.ts). */
  updateRunners: () => Promise<void>;
};

type Log = (message: string) => void;

/**
 * The long-running scheduler for a private VM. It replaces the 60 s /api/cron call:
 * - fast (5 s): webhook delivery;
 * - sync (5 s check): GitHub sync for each due user, by SYNC_TIERS;
 * - minute: idle warning and idle stop, budget, diagnostics, and the heartbeat row;
 * - runner (1 min): in-place runner update of quiet running phones;
 * - hourly: retention warnings and auto-keep.
 * Users run in parallel, at most `limit` at a time. Only the holder of SCHEDULER_LEASE runs loops.
 */
export function createScheduler({ database, parts, clock = Date.now, limit = 8, log = message => console.log(message),
  leaseRetryMs = 30_000, renewMs = 20_000 }: {
  database: Client; parts: SchedulerParts; clock?: () => number; limit?: number; log?: Log;
  leaseRetryMs?: number; renewMs?: number;
}) {
  const owner = randomUUID();
  let stopping = false;
  let leader = false;
  /** Each lease win starts one set of loops; a loop from an older win exits. */
  let generation = 0;
  const sleepers = new Set<() => void>();
  const inFlight = new Set<Promise<unknown>>();
  const syncing = new Set<number>();

  /** Sleep that ends early on stop. A loop that was mid-work when stop ran must not start a new sleep. */
  function pause(ms: number) {
    return new Promise<void>(resolve => {
      if (stopping) return resolve();
      const done = () => { clearTimeout(timer); sleepers.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      sleepers.add(done);
    });
  }

  async function users() {
    const rows = (await database.execute(`SELECT p.user_id, p.state, p.android_state, s.synced_at FROM phones p
      JOIN users u ON u.id = p.user_id LEFT JOIN user_syncs s ON s.user_id = p.user_id
      WHERE u.blocked = 0 AND p.state != 'deleted' AND p.codespace_name NOT LIKE 'pending:%'`)).rows;
    const byUser = new Map<number, { userId: number; phones: PhoneState[]; syncedAt: number | null }>();
    for (const row of rows) {
      const userId = Number(row.user_id);
      const user = byUser.get(userId) ?? { userId, phones: [], syncedAt: row.synced_at == null ? null : Number(row.synced_at) };
      user.phones.push({ state: String(row.state), android_state: row.android_state == null ? null : String(row.android_state) });
      byUser.set(userId, user);
    }
    return [...byUser.values()];
  }

  async function syncDue() {
    const due = dueUsers(await users(), clock()).filter(id => !syncing.has(id));
    await eachLimited(due, limit, async userId => {
      if (await parts.backoffLeft(userId)) return;
      syncing.add(userId);
      try { await parts.sync(userId); await parts.clearBackoff(userId); }
      catch (error) { await parts.backOff(userId, error); }
      finally { syncing.delete(userId); }
    });
  }

  async function minute() {
    await recordSchedulerRun(database, "reconcile", async () => {
      await parts.minute();
      const ids = (await users()).map(user => user.userId);
      await eachLimited(ids, limit, async userId => { if (!(await parts.backoffLeft(userId))) await parts.protectBudget(userId); });
    }, clock);
  }

  async function hourly() {
    const ids = (await users()).map(user => user.userId);
    await eachLimited(ids, limit, async userId => { if (!(await parts.backoffLeft(userId))) await parts.protectRetention(userId); });
  }

  /** Run work, then wait `ms` after it ends, so one loop never overlaps itself. */
  async function loop(name: string, ms: number, work: () => Promise<void>) {
    const mine = generation;
    while (!stopping && leader && generation === mine) {
      const started = clock();
      const run = work().catch(error => log(`[scheduler] ${name} failed: ${error instanceof Error ? error.name : "unknown"}`));
      inFlight.add(run);
      await run;
      inFlight.delete(run);
      const took = clock() - started;
      if (took > ms) log(`[scheduler] ${name} took ${took} ms, more than its ${ms} ms interval`);
      await pause(Math.max(0, ms - took));
    }
  }

  async function holdLease() {
    while (!stopping) {
      try {
        if (leader) {
          if (!(await renewLease(database, SCHEDULER_LEASE, owner))) { leader = false; log("[scheduler] lease lost; standing by"); }
        } else if (await claimLease(database, SCHEDULER_LEASE, owner)) {
          leader = true;
          generation++;
          log("[scheduler] lease held; loops start");
          void Promise.all([loop("fast", LOOP_MS.fast, parts.deliver), loop("sync", LOOP_MS.sync, syncDue),
            loop("minute", LOOP_MS.minute, minute),
            loop("runner", LOOP_MS.runner, parts.updateRunners), loop("hourly", LOOP_MS.hourly, hourly)]);
        }
      } catch (error) {
        // A database fault: keep the loops only while the lease time may still be ours.
        log(`[scheduler] lease check failed: ${error instanceof Error ? error.name : "unknown"}`);
      }
      await pause(leader ? renewMs : leaseRetryMs);
    }
  }

  let held: Promise<void> | undefined;
  return {
    start() { held ??= holdLease(); return held; },
    get leader() { return leader; },
    /** Stop the loops, wait up to `waitMs` for running work, then give the lease back. */
    async stop(waitMs = 60_000) {
      stopping = true;
      for (const done of [...sleepers]) done();
      const idle = Promise.allSettled([...inFlight]);
      await Promise.race([idle, new Promise(resolve => setTimeout(resolve, waitMs).unref())]);
      if (leader) await releaseLease(database, SCHEDULER_LEASE, owner).catch(() => {});
      leader = false;
    },
    /** For tests and tools: one pass of each part. */
    syncDue, minute, hourly,
  };
}
