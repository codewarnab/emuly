import type { DatabaseSync } from "node:sqlite";
import { diagnosticId, operationKinds, outcomes, validateStep } from "./diagnostic-contract.ts";

const safeRelease = (v: unknown) => v === "unknown" || (typeof v === "string" && /^[a-f0-9]{7,40}$/.test(v));
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;

/** Local-only read boundary. Outputs never contain ownership IDs, source text, or wall-clock timestamps. */
export function diagnosticReport(database: DatabaseSync, mode: string, operationId?: string) {
  if (mode === "list") return database.prepare(`SELECT id, kind, outcome, started_at, dropped_records FROM diagnostic_operations
    ORDER BY rowid DESC LIMIT 50`).all().flatMap(r => diagnosticId(r.id) && operationKinds.includes(r.kind as never) && outcomes.includes(r.outcome as never)
      ? [{ operation: r.id, kind: r.kind, outcome: r.outcome, stale: Date.now() - Date.parse(String(r.started_at)) > 3600000,
        droppedRecords: integer(r.dropped_records) ? r.dropped_records : null }] : []);
  if (mode === "health") return {
    counters: database.prepare("SELECT code, count FROM diagnostic_health LIMIT 4").all().filter(r =>
      ["writeFailures", "invalidRecords", "droppedRecords", "collectorFailures"].includes(String(r.code)) && integer(r.count)),
    databaseBytes: Number(database.prepare("PRAGMA page_count").get()?.page_count ?? 0) * Number(database.prepare("PRAGMA page_size").get()?.page_size ?? 0),
  };
  if (mode === "aggregate") return aggregate(database);
  if (mode !== "timeline" || !diagnosticId(operationId)) throw new Error("Invalid report request");
  const operation = database.prepare("SELECT run_id, started_at FROM diagnostic_operations WHERE id = ?").get(operationId);
  if (!operation) throw new Error("Operation unavailable");
  const origin = database.prepare("SELECT min(started_at) AS ts FROM diagnostic_operations WHERE run_id = ?").get(operation.run_id);
  const start = Date.parse(String(origin?.ts));
  const rows = database.prepare(`SELECT s.record, s.observed_at FROM diagnostic_steps s JOIN diagnostic_operations o ON o.id = s.operation_id
    WHERE o.run_id = ? ORDER BY s.observed_at, s.rowid LIMIT 501`).all(operation.run_id);
  const records = rows.slice(0, 500).flatMap(row => {
    try { const step = validateStep(JSON.parse(String(row.record))); return step ? [{ step, observed: String(row.observed_at) }] : []; }
    catch { return []; }
  });
  const timeline = records.map(({ step: s, observed }, i) => ({
    row: i + 1, parentRow: s.parentStepId ? records.findIndex(r => r.step.stepId === s.parentStepId) + 1 || null : null,
    observedAfterMs: Math.max(0, Date.parse(observed) - start), sourceDurationMs: s.durationMs ?? null,
    producer: s.producer, code: s.code, attempt: s.attempt, outcome: s.outcome, error: s.errorCode, quality: s.quality,
    route: s.route, disposition: s.disposition, bootMethod: s.bootMethod, retryDelayMs: s.retryDelayMs,
    httpStatus: s.httpStatus, exitCode: s.exitCode,
    viewerCount: s.count, visible: s.visible, recentInput: s.recentInput, presenceLeaseMs: s.presenceLeaseMs,
    consecutiveFailures: s.consecutiveFailures, sinceSuccessMs: s.sinceSuccessMs,
    idleTimeoutMin: s.idleTimeoutMin, evidenceSource: s.evidenceSource,
    providerActivityAgeMs: s.providerActivityAt ? Math.max(0, Date.parse(observed) - Date.parse(s.providerActivityAt)) : null,
    cause: s.cause, confidence: s.confidence, initiator: s.initiator,
  }));
  const stop = records.map(r => r.step).findLast(s => s.code === "provider_stop");
  const ready = records.find(r => r.step.code === "android_boot" && r.step.outcome === "succeeded");
  const paint = records.find(r => r.step.code === "first_painted");
  const dropped = database.prepare("SELECT sum(dropped_records) AS n FROM diagnostic_operations WHERE run_id = ?").get(operation.run_id)?.n;
  return { timeline, truncated: rows.length > 500, droppedRecords: integer(dropped) ? dropped : null,
    startup: { androidReadyObservedAfterMs: ready ? Math.max(0, Date.parse(ready.observed) - start) : null,
      firstPaintObservedAfterMs: paint ? Math.max(0, Date.parse(paint.observed) - start) : null, quality: "observed_interval" },
    firstFrame: records.some(r => r.step.code === "first_painted") ? "observed" : "missing",
    shutdown: { cause: stop?.cause ?? "unknown", confidence: stop?.confidence ?? "unknown",
      missingEvidence: ["provider_shutdown_reason", "verified_provider_idle_reset", ...(stop?.evidenceSource === "provider" ? [] : ["effective_provider_timeout"])] },
    timing: "Source durations are independent. Observed offsets include polling delay. Nested steps overlap." };
}

function aggregate(database: DatabaseSync) {
  const rows = database.prepare("SELECT * FROM diagnostic_daily ORDER BY day DESC LIMIT 10001").all();
  const groups = new Map<string, { release: string; code: string; quality: string; disposition: string; bootMethod: string;
    cause: string; confidence: string; count: number; failures: number; incomplete: number; durations: [number, number][] }>();
  for (const r of rows.slice(0, 10000)) {
    const candidate = validateStep({ stepId: "0".repeat(32), producerRunId: "0".repeat(32), producer: "server", sequence: 1, attempt: 1,
      code: r.code, outcome: r.outcome, quality: r.quality, disposition: r.disposition, bootMethod: r.boot_method, cause: r.cause, confidence: r.confidence,
      startedAt: "2026-01-01T00:00:00.000Z", ...(r.outcome === "running" ? {} : { finishedAt: "2026-01-01T00:00:00.000Z" }), errorCode: "none" });
    if (!candidate || !safeRelease(r.release) || !integer(r.samples) || !Number.isSafeInteger(r.bucket_ms) || Number(r.bucket_ms) < -1 || Number(r.bucket_ms) > 134217728) continue;
    const key = JSON.stringify([r.release, r.code, r.quality, r.disposition, r.boot_method, r.cause, r.confidence]);
    const g = groups.get(key) ?? { release: String(r.release), code: String(r.code), quality: String(r.quality), disposition: String(r.disposition),
      bootMethod: String(r.boot_method), cause: String(r.cause), confidence: String(r.confidence), count: 0, failures: 0, incomplete: 0, durations: [] };
    g.count += Number(r.samples);
    if (r.outcome === "failed") g.failures += Number(r.samples);
    if (["unknown", "interrupted", "cancelled", "running"].includes(String(r.outcome))) g.incomplete += Number(r.samples);
    if (r.outcome === "succeeded" && r.quality !== "missing" && Number(r.bucket_ms) >= 0) g.durations.push([Number(r.bucket_ms), Number(r.samples)]);
    groups.set(key, g);
  }
  return { truncated: rows.length > 10000, percentileMethod: "Logarithmic bucket upper bounds; successful durations only; 90-day retention.",
    stages: [...groups.values()].map(({ durations, ...g }) => ({ ...g, failureRate: g.failures / g.count,
      durationSamples: durations.reduce((n, [, count]) => n + count, 0), insufficientSamples: g.count < 20,
      medianMsUpperBound: percentile(durations, .5), p95MsUpperBound: percentile(durations, .95) })) };
}
function percentile(buckets: [number, number][], fraction: number) {
  const total = buckets.reduce((n, [, count]) => n + count, 0);
  if (!total) return null;
  let n = 0;
  for (const [duration, count] of buckets.sort((a, b) => a[0] - b[0])) { n += count; if (n >= Math.ceil(total * fraction)) return duration; }
  return null;
}
