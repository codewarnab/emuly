import type { Client } from "@libsql/client";
import { MIN_GROUP, bucketOf } from "./api-usage.ts";

/**
 * Anonymous phone state-change counts: how long a cold start takes, how often a start fails and why,
 * how often the idle stop fires.
 *
 * Anonymity rules (docs/diagnostics-overhaul-plan.md, Part 2):
 * - No user, phone, codespace or IP is stored. States, reasons and error codes come from fixed lists.
 * - Only the UTC day is stored, never the time of day. Rows are counters, not events.
 * - The region is a GitHub region name ("EastUs"), or "unknown". Reports hide groups with fewer than MIN_GROUP samples.
 *
 * Speed: record() returns at once. Counts go to an in-memory map. One background flush writes them
 * in a single batch, and concurrent state changes share that flush. A failed write is dropped.
 */

export const phoneStates = ["creating", "booting", "running", "stopping", "stopped", "error", "deleted"] as const;
export const stateReasons = ["user", "hours_budget", "retention", "provider", "idle", "error", "system"] as const;
export const stateErrors = ["none", "github_quota", "github_auth", "kvm_missing", "boot_timeout", "runner_crash", "tunnel_lost",
  "setup_failed", "provider_unavailable", "unknown_failure"] as const;
export type StateReason = typeof stateReasons[number];
export type StateError = typeof stateErrors[number];
const ROW_LIMIT = 64;

export type StateChange = {
  from: string; to: string; reason: StateReason; error?: StateError;
  /** GitHub region of the codespace, for example "EastUs". Anything else becomes "unknown". */
  region?: string | null;
  /** When the phone entered `from`, as an ISO time or epoch ms. Only the bucketed duration is stored. */
  since?: string | number | null;
  now?: number;
};

const pick = <T extends string>(list: readonly T[], value: unknown, fallback: T): T => list.includes(value as T) ? value as T : fallback;
const day = (now: number) => new Date(now).toISOString().slice(0, 10);
/** Region names are short words shared by every user there. Any other text is dropped. */
const regionOf = (value: unknown) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{1,23}$/.test(value) ? value : "unknown";

/**
 * Maps a GitHub or setup failure to a fixed error code. Reads only status numbers and a few
 * known words. The message text itself is never stored.
 */
export function stateErrorOf(error: unknown): StateError {
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 0;
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (status === 401) return "github_auth";
  if (/quota|spending limit|billing|limit reached/i.test(text) || status === 402) return "github_quota";
  if (status === 403) return "github_auth";
  if (/\bkvm\b/i.test(text)) return "kvm_missing";
  if (/timed? ?out|timeout/i.test(text)) return "boot_timeout";
  if (/runner/i.test(text) && /crash|exit|died/i.test(text)) return "runner_crash";
  if (/tunnel/i.test(text)) return "tunnel_lost";
  if (/setup/i.test(text)) return "setup_failed";
  if (status >= 500) return "provider_unavailable";
  return "unknown_failure";
}

export function createStateCounts(database: () => Client, schedule: (task: Promise<unknown>) => void = () => {}) {
  const counts = new Map<string, number>();
  let flushing: Promise<void> | undefined;

  async function flush() {
    while (counts.size) {
      const rows = [...counts].slice(0, ROW_LIMIT);
      for (const [key] of rows) counts.delete(key);
      try {
        await database().batch(rows.map(([key, n]) => ({
          sql: `INSERT INTO diagnostic_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET samples = samples + excluded.samples`,
          args: [...JSON.parse(key) as (string | number)[], n] })), "write");
      } catch { /* Counts are best effort. A failed batch never reaches a request. */ }
    }
  }

  return {
    /** Counts one state change. Returns at once; the write happens in the background. Same-state calls are ignored. */
    record(change: StateChange) {
      if (process.env.EMULY_DIAGNOSTICS !== "1" || change.from === change.to) return;
      try {
        const now = change.now ?? Date.now();
        const since = typeof change.since === "number" ? change.since : change.since ? Date.parse(change.since) : NaN;
        const key = [day(now), process.env.EMULY_RELEASE?.slice(0, 7) || "unknown", pick(phoneStates, change.from, "creating"),
          pick(phoneStates, change.to, "error"), pick(stateReasons, change.reason, "system"), pick(stateErrors, change.error, "none"),
          regionOf(change.region), Number.isFinite(since) ? bucketOf(now - since) : 0];
        const text = JSON.stringify(key);
        counts.set(text, (counts.get(text) ?? 0) + 1);
      } catch { return; }
      if (!flushing) {
        flushing = flush().finally(() => { flushing = undefined; });
        schedule(flushing);
      }
    },
    /** Resolves when the counts in memory are written. For tests. */
    async settled() { while (flushing) await flushing; },
  };
}

/** Anonymous state reports. Groups with fewer than MIN_GROUP samples are hidden. */
export async function stateReport(database: Pick<Client, "execute">, days = 7) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = (await database.execute({ sql: `SELECT from_state, to_state, reason, error_code, sum(samples) AS samples,
    group_concat(bucket_ms || ':' || samples) AS buckets FROM diagnostic_states WHERE day >= ?
    GROUP BY from_state, to_state, reason, error_code HAVING sum(samples) >= ? ORDER BY samples DESC LIMIT 200`, args: [since, MIN_GROUP] })).rows;
  const regions = (await database.execute({ sql: `SELECT region, sum(samples) AS samples FROM diagnostic_states WHERE day >= ?
    GROUP BY region HAVING sum(samples) >= ? ORDER BY samples DESC`, args: [since, MIN_GROUP] })).rows;
  return {
    transitions: rows.map(r => ({ from: r.from_state, to: r.to_state, reason: r.reason, error: r.error_code, samples: Number(r.samples),
      p50Ms: percentile(String(r.buckets), 0.5), p95Ms: percentile(String(r.buckets), 0.95) })),
    regions: regions.map(r => ({ region: r.region, samples: Number(r.samples) })),
  };
}

/** Percentile as a bucket upper bound, from "bucket:samples" pairs. */
function percentile(pairs: string, p: number) {
  const list = pairs.split(",").map(pair => pair.split(":").map(Number) as [number, number]).sort((a, b) => a[0] - b[0]);
  const total = list.reduce((sum, [, n]) => sum + n, 0);
  let seen = 0;
  for (const [bucket, n] of list) { seen += n; if (seen >= total * p) return bucket; }
  return null;
}
