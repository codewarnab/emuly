import type { Client } from "@libsql/client";
import { V1_ROUTES } from "../v1-routes.ts";
import { AGENT_RUNBOOK_VERSION } from "../agent-runbook.ts";

/**
 * Anonymous /v1 API usage counts, so we can see which routes agents use, how fast they are,
 * which calls fail and which call patterns waste time.
 *
 * Anonymity rules (docs/diagnostics-overhaul-plan.md):
 * - No user, phone, key, codespace or IP is stored. Paths become route templates
 *   ("POST /v1/phones/{id}/adb"). Error codes come from a fixed list.
 * - Only the UTC day is stored, never the time of day. Rows are counters, not events.
 * - Reports hide any group with fewer than MIN_GROUP samples.
 * - The pattern detector keeps a short in-memory window per caller, keyed by a hash that is never
 *   stored. It ends with the function instance.
 *
 * Speed: nothing here is awaited by a request. Counts go to an in-memory map. One background
 * flush writes them in a single batch, and concurrent requests share that flush.
 */

export const MIN_GROUP = 10;
const ROUTE_LIMIT = 64;
export const apiClients = ["cli", "skill", "browser", "curl", "other"] as const;
export const apiAuth = ["agent_key", "session", "none"] as const;
export const apiPatterns = ["poll_after_wait", "retry_same_route", "screenshot_burst", "unknown_route", "old_client"] as const;
export type ApiPattern = typeof apiPatterns[number];
/** Error codes worth counting. Any other value in a response body becomes "other". */
const knownErrors = new Set(["access_denied", "authorization_pending", "bad_event", "bad_signature", "busy", "denied",
  "direct_upload_unavailable", "expired_token", "forbidden", "github_refused", "invalid_code", "invalid_grant", "invalid_input",
  "invalid_path", "invalid_response", "method_not_allowed", "not_available", "not_found", "phone_conflict", "phone_not_ready",
  "rate_limited", "request_failed", "runner_update_required", "slow_down", "timeout", "ui_unavailable", "unauthorized", "upload_too_large"]);

const templates = V1_ROUTES.map(route => {
  const [method, path] = route.split(" ") as [string, string];
  const parts = path.split("/").map(part => {
    if (!part.startsWith("{")) return part.replace(/[.*+?^$()[\]\\]/g, "\\$&");
    const choices = part.slice(1, -1).split("|");
    return choices.length > 1 ? `(?:${choices.join("|")})` : "[^/]+";
  });
  return { route, method, pattern: new RegExp(`^${parts.join("/")}/?$`) };
});

/** The route template for a request, or "unknown". Never the real path, which holds ids. */
export function routeTemplate(method: string, pathname: string): string {
  const upper = method.toUpperCase();
  const match = templates.find(t => (t.method === upper || (upper === "HEAD" && t.method === "GET")) && t.pattern.test(pathname));
  return match ? match.route : `${upper} unknown`;
}

/** The kind of client, from headers only. The CLI sends X-Emuly-Client, the skill sends X-Emuly-Skill. */
export function clientOf(headers: Headers): { client: typeof apiClients[number]; version: string } {
  const skill = headers.get("x-emuly-skill"), cli = headers.get("x-emuly-client");
  if (cli?.startsWith("cli")) return { client: "cli", version: "unknown" };
  // Skill versions are dates shared by every user of that release, for example 2026-11-25.2.
  if (skill) return { client: "skill", version: /^\d{4}-\d\d-\d\d(\.\d{1,3})?$/.test(skill) ? skill : "unknown" };
  const agent = headers.get("user-agent") ?? "";
  if (/^Mozilla\//.test(agent)) return { client: "browser", version: "unknown" };
  if (/^curl\//i.test(agent)) return { client: "curl", version: "unknown" };
  return { client: "other", version: "unknown" };
}

export function authOf(headers: Headers): typeof apiAuth[number] {
  if (/^Bearer\s+\S/i.test(headers.get("authorization") ?? "")) return "agent_key";
  return /(^|;\s*)(__Host-)?emuly_session=/.test(headers.get("cookie") ?? "") ? "session" : "none";
}

export const bucketOf = (ms: number) => ms <= 0 ? 0 : 2 ** Math.ceil(Math.log2(Math.min(ms, 86_400_000)));
export const errorOf = (code: unknown) => typeof code !== "string" ? "other" : knownErrors.has(code) ? code : "other";
const day = (now: number) => new Date(now).toISOString().slice(0, 10);

export type ApiCall = { method: string; pathname: string; headers: Headers; status: number; durationMs: number; error?: unknown; now?: number };

/** Short in-memory windows per caller. The key is a hash of the auth header; it is never stored. */
type Window = { last?: { route: string; at: number; failed: boolean; phone?: string }; shots: number[]; burstAt?: number; waitAt: Map<string, number> };

export function createApiUsage(database: () => Client, schedule: (task: Promise<unknown>) => void = () => {}) {
  const counts = new Map<string, number>();
  const windows = new Map<string, Window>();
  let flushing: Promise<void> | undefined;

  function add(key: unknown[]) {
    const text = JSON.stringify(key);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }

  function patterns(call: ApiCall, route: string, now: number, caller: string, client: string, version: string): ApiPattern[] {
    const found: ApiPattern[] = [];
    if (route.endsWith(" unknown")) found.push("unknown_route");
    if (client === "skill" && version !== "unknown" && version < AGENT_RUNBOOK_VERSION) found.push("old_client");
    if (!caller) return found;
    const w: Window = windows.get(caller) ?? { shots: [], waitAt: new Map() };
    windows.set(caller, w);
    // The phone id is used only inside this window, to match a poll to the call before it.
    const phone = /^\/v1\/phones\/([^/]+)/.exec(call.pathname)?.[1];
    if (w.last && w.last.route === route && w.last.failed && now - w.last.at < 5_000) found.push("retry_same_route");
    if (route === "GET /v1/phones/{id}" && phone && now - (w.waitAt.get(phone) ?? -Infinity) < 2_000) found.push("poll_after_wait");
    if (/^POST \/v1\/phones\/\{id\}\/(start|stop)$/.test(route) && phone) w.waitAt.set(phone, now);
    if (route === "GET /v1/phones/{id}/screenshot") {
      w.shots = w.shots.filter(at => now - at < 60_000).concat(now);
      if (w.shots.length > 10 && now - (w.burstAt ?? -Infinity) > 60_000) { found.push("screenshot_burst"); w.burstAt = now; }
    }
    w.last = { route, at: now, failed: call.status >= 400, phone };
    if (windows.size > 5_000) windows.delete(windows.keys().next().value!);
    return found;
  }

  async function flush() {
    while (counts.size) {
      const rows = [...counts].slice(0, ROUTE_LIMIT);
      for (const [key] of rows) counts.delete(key);
      const statements = rows.map(([key, n]) => {
        const value = JSON.parse(key) as (string | number)[];
        return value[0] === "pattern"
          ? { sql: `INSERT INTO diagnostic_api_patterns VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET samples = samples + excluded.samples`, args: [value[1]!, value[2]!, n] }
          : { sql: `INSERT INTO diagnostic_api VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET samples = samples + excluded.samples`, args: [...value, n] };
      });
      try { await database().batch(statements, "write"); }
      catch { /* Counts are best effort. A failed batch never reaches a request. */ }
    }
  }

  return {
    /** Counts one call. Returns at once; the write happens in the background. */
    record(call: ApiCall, caller = "") {
      try {
        const now = call.now ?? Date.now(), route = routeTemplate(call.method, call.pathname);
        const { client, version } = clientOf(call.headers);
        const status = call.status >= 500 ? "5xx" : call.status >= 400 ? "4xx" : call.status >= 300 ? "3xx" : "2xx";
        add([day(now), process.env.EMULY_RELEASE?.slice(0, 7) || "unknown", route, client, version, authOf(call.headers), status,
          call.status >= 400 ? errorOf(call.error) : "none", bucketOf(call.durationMs)]);
        for (const pattern of patterns(call, route, now, caller, client, version)) add(["pattern", day(now), pattern]);
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

/** Anonymous usage reports. Groups with fewer than MIN_GROUP samples are hidden. */
export async function apiUsageReport(database: Pick<Client, "execute">, days = 7) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const routes = (await database.execute({ sql: `SELECT route, client, status_class, error_code, sum(samples) AS samples,
    group_concat(bucket_ms || ':' || samples) AS buckets FROM diagnostic_api WHERE day >= ?
    GROUP BY route, client, status_class, error_code HAVING sum(samples) >= ? ORDER BY samples DESC LIMIT 200`, args: [since, MIN_GROUP] })).rows;
  const patterns = (await database.execute({ sql: `SELECT pattern, sum(samples) AS samples FROM diagnostic_api_patterns WHERE day >= ?
    GROUP BY pattern HAVING sum(samples) >= ? ORDER BY samples DESC`, args: [since, MIN_GROUP] })).rows;
  return {
    routes: routes.map(r => ({ route: r.route, client: r.client, status: r.status_class, error: r.error_code, samples: Number(r.samples),
      p50Ms: percentile(String(r.buckets), 0.5), p95Ms: percentile(String(r.buckets), 0.95) })),
    patterns: patterns.map(r => ({ pattern: r.pattern, samples: Number(r.samples) })),
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
