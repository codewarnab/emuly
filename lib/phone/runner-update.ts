import type { Client } from "@libsql/client";
import { eachLimited } from "./scheduler.ts";
import { CoordinationBusyError } from "../data/coordination.ts";

/** What GET /health on a runner returns. `busy` exists from runner version 17. */
export type RunnerHealth = {
  ok?: boolean; version?: number; scripts?: string;
  /** Fingerprint of the runner key the runner loaded (phone/runner/runner-key.mjs). Null or absent: no key. */
  key?: string | null;
  busy?: { viewers?: number; links?: number; work?: number; idle_ms?: number };
};

export const RUNNER_UPDATE = {
  /** No agent or browser use (phones.last_activity_at) and no Android input for this long. */
  quietMs: 5 * 60_000,
  /** The runner had no request for this long, so a burst of calls is not cut. */
  runnerQuietMs: 30_000,
  /** Phones updated at the same time. */
  limit: 2,
  /** Wait for the new runner to answer /health with the new version. */
  confirmMs: 90_000,
  confirmPauseMs: 3_000,
  /** Wait before the next try after a failure: 5, 15, then 60 min. */
  backoffMs: [5 * 60_000, 15 * 60_000, 60 * 60_000],
} as const;

/** `key`: the expected runner key fingerprint. Undefined skips that check (callers without a key source). */
export function runnerCurrent(health: RunnerHealth | null, version: number, scripts: string, key?: string | null) {
  return health?.ok === true && health.version === version && health.scripts === scripts
    && (key === undefined || (health.key ?? null) === key);
}

/**
 * The runner is newer than this server's copy. This server is then an old deploy (for example the VM
 * scheduler before its redeploy), and it must not install its older runner over the newer one.
 */
export function runnerNewer(health: RunnerHealth | null, version: number) {
  return health?.ok === true && typeof health.version === "number" && health.version > version;
}

/**
 * The runner restarts only when nobody uses it: no stream viewer (a recording counts as one),
 * no link, no request in progress, and no request in the last RUNNER_UPDATE.runnerQuietMs.
 * A runner older than 17 does not report `busy`; then the server-side quiet time decides alone.
 */
export function runnerIdle(health: RunnerHealth) {
  const busy = health.busy;
  if (!busy) return true;
  return (busy.viewers ?? 0) === 0 && (busy.links ?? 0) === 0 && (busy.work ?? 0) === 0
    && (busy.idle_ms ?? 0) >= RUNNER_UPDATE.runnerQuietMs;
}

export type UpdatePhone = { userId: number; id: string; codespaceName: string; lastActivityAt: string | null; devicePreset: string | null };

export type RunnerUpdateDeps = {
  database: Client;
  version: number;
  scripts: () => string;
  health: (phone: UpdatePhone) => Promise<RunnerHealth | null>;
  androidIdleMs: (phone: UpdatePhone) => Promise<number | null>;
  /** Writes the new files and restarts only the runner (setupPhone). Android keeps running. */
  install: (phone: UpdatePhone) => Promise<{ state: string }>;
  /** Expected runner key fingerprint for a codespace (direct-ticket.ts). Undefined: no key check. */
  keyFingerprint?: (codespaceName: string) => string | null | undefined;
  /** Runs work under the user's phone lease, so a start or a stop waits. Throws when the lease is busy. */
  withUserLease: <T>(userId: number, work: () => Promise<T>) => Promise<T>;
  clock?: () => number;
  pause?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
};

/**
 * Updates the runner of running phones in place after a deploy changes RUNNER_VERSION or a
 * phone file. Only phones that are running and ready, with no boot or stop in progress, and
 * only at a quiet time. A failure waits with a growing backoff.
 */
export function createRunnerUpdater({ database, version, scripts, health, androidIdleMs, install, withUserLease, keyFingerprint = () => undefined,
  clock = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), log = message => console.log(message) }: RunnerUpdateDeps) {
  const failures = new Map<string, { count: number; until: number }>();
  const active = new Set<string>();

  async function candidates() {
    const rows = (await database.execute(`SELECT p.user_id, p.id, p.codespace_name, p.last_activity_at, p.device_preset FROM phones p
      JOIN users u ON u.id = p.user_id WHERE u.blocked = 0 AND p.state = 'running' AND p.android_state = 'ready'
      AND p.codespace_name NOT LIKE 'pending:%'`)).rows;
    return rows.map(row => ({ userId: Number(row.user_id), id: String(row.id), codespaceName: String(row.codespace_name),
      lastActivityAt: row.last_activity_at == null ? null : String(row.last_activity_at),
      devicePreset: row.device_preset == null ? null : String(row.device_preset) }));
  }

  function quiet(phone: UpdatePhone, now: number) {
    if (!phone.lastActivityAt) return true;
    const at = Date.parse(phone.lastActivityAt);
    return !Number.isFinite(at) || now - at >= RUNNER_UPDATE.quietMs;
  }

  function fail(phone: UpdatePhone, reason: string) {
    const count = (failures.get(phone.id)?.count ?? 0) + 1;
    const wait = RUNNER_UPDATE.backoffMs[Math.min(count, RUNNER_UPDATE.backoffMs.length) - 1]!;
    failures.set(phone.id, { count, until: clock() + wait });
    log(`[runner-update] ${phone.id} failed (${reason}); next try in ${Math.round(wait / 60_000)} min`);
    return "failed" as const;
  }

  async function stillReady(phone: UpdatePhone) {
    const row = (await database.execute({ sql: `SELECT 1 FROM phones WHERE id = ? AND user_id = ? AND state = 'running'
      AND android_state = 'ready' AND codespace_name = ?`, args: [phone.id, phone.userId, phone.codespaceName] })).rows[0];
    return Boolean(row);
  }

  /** Keeps phones.runner_version at the last version /health reported. Writes only on a change. */
  async function record(phone: UpdatePhone, runnerVersion: number | undefined) {
    if (typeof runnerVersion !== "number") return;
    await database.execute({ sql: "UPDATE phones SET runner_version = ? WHERE id = ? AND runner_version IS NOT ?",
      args: [runnerVersion, phone.id, runnerVersion] }).catch(() => {});
  }

  type Result = "current" | "newer" | "busy" | "updated" | "failed" | "waiting";
  async function updateOne(phone: UpdatePhone): Promise<Result> {
    const now = clock();
    const backoff = failures.get(phone.id);
    if (backoff && now < backoff.until) return "waiting";
    if (!quiet(phone, now)) return "busy";
    const before = await health(phone).catch(() => null);
    // No answer: the phone may be booting or stopping; the sync and setup paths own that.
    if (!before) return "busy";
    await record(phone, before.version);
    if (runnerNewer(before, version)) { failures.delete(phone.id); return "newer"; }
    if (runnerCurrent(before, version, scripts(), keyFingerprint(phone.codespaceName))) { failures.delete(phone.id); return "current"; }
    if (!runnerIdle(before)) return "busy";
    const android = await androidIdleMs(phone).catch(() => null);
    if (android !== null && android < RUNNER_UPDATE.quietMs) return "busy";
    let result: Result;
    try {
      result = await withUserLease(phone.userId, async () => {
        // A start, a stop, or a user action may have come while we checked.
        if (!(await stillReady(phone))) return "busy";
        const fresh = (await database.execute({ sql: "SELECT last_activity_at FROM phones WHERE id = ?", args: [phone.id] })).rows[0];
        if (!quiet({ ...phone, lastActivityAt: fresh?.last_activity_at == null ? null : String(fresh.last_activity_at) }, clock())) return "busy";
        log(`[runner-update] ${phone.id}: runner ${before.version ?? "?"} -> ${version}`);
        const setup = await install(phone);
        if (setup.state === "failed") return fail(phone, "setup failed");
        const until = clock() + RUNNER_UPDATE.confirmMs;
        for (;;) {
          if (runnerCurrent(await health(phone).catch(() => null), version, scripts(), keyFingerprint(phone.codespaceName))) {
            failures.delete(phone.id);
            await record(phone, version);
            log(`[runner-update] ${phone.id}: runner ${version} answers; Android kept running`);
            return "updated";
          }
          if (clock() >= until) return fail(phone, "new runner did not answer");
          await pause(RUNNER_UPDATE.confirmPauseMs);
        }
      });
    } catch (error) {
      // A busy lease means a start or a stop runs now: try at the next pass, without backoff.
      if (error instanceof CoordinationBusyError) return "busy";
      return fail(phone, error instanceof Error ? error.name : "unknown");
    }
    return result;
  }

  /** One pass over all running phones. Returns each phone's result, for tests and logs. */
  async function pass() {
    const results = new Map<string, Result>();
    const phones = (await candidates()).filter(phone => !active.has(phone.id));
    await eachLimited(phones, RUNNER_UPDATE.limit, async phone => {
      active.add(phone.id);
      try { results.set(phone.id, await updateOne(phone)); } finally { active.delete(phone.id); }
    });
    return results;
  }
  return { pass };
}
