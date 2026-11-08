import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { errorCodes, validateStep, type Step, type StepCode, type Outcome, type OperationKind, type ErrorCode } from "./diagnostic-contract.ts";

type Scope = { store: Diagnostics; operationId: string; parentStepId?: string };
const context = new AsyncLocalStorage<Scope>();
export const newDiagnosticId = () => randomBytes(16).toString("hex");
const observer = newDiagnosticId();
const healthFlushes = new WeakMap<DatabaseSync, typeof diagnosticHealth>();
const sequences = new Map<string, number>();
function nextSequence(operationId: string) {
  const value = Math.min(100000, (sequences.get(operationId) ?? 0) + 1);
  sequences.set(operationId, value);
  return value;
}
export const diagnosticHealth = { writeFailures: 0, invalidRecords: 0, droppedRecords: 0, collectorFailures: 0 };
const release = () => /^[a-f0-9]{7,40}$/.test(process.env.PHONELINK_RELEASE ?? "") ? process.env.PHONELINK_RELEASE! : "unknown";
export type Diagnostics = ReturnType<typeof createDiagnostics>;

/** Failure-isolated, bounded private store. No activity events, logs, or webhooks. */
export function createDiagnostics(database: DatabaseSync) {
  const starts = new Map<string, number>();
  const flushed = healthFlushes.get(database) ?? { writeFailures: 0, invalidRecords: 0, droppedRecords: 0, collectorFailures: 0 };
  healthFlushes.set(database, flushed);
  const allowed = (phoneId?: string) => process.env.PHONELINK_DIAGNOSTICS === "1"
    && (!phoneId || !process.env.PHONELINK_DIAGNOSTICS_PHONE || phoneId === process.env.PHONELINK_DIAGNOSTICS_PHONE);
  function safely<T>(work: () => T): T | undefined {
    try { return work(); } catch { diagnosticHealth.writeFailures++; return undefined; }
  }
  function operation(ownerId: number, phoneId: string, kind: OperationKind, fresh = false): string | undefined {
    if (!allowed(phoneId)) return;
    return safely(() => {
      const phone = database.prepare("SELECT state FROM phones WHERE id = ? AND user_id = ? AND state != 'deleted'").get(phoneId, ownerId);
      if (!phone) return;
      const existing = database.prepare(`SELECT id FROM diagnostic_operations WHERE owner_id = ? AND phone_id = ?
        AND kind = ? AND outcome = 'running' ORDER BY started_at DESC LIMIT 1`).get(ownerId, phoneId, kind);
      if (existing && !fresh) return String(existing.id);
      const current = database.prepare("SELECT run_id FROM diagnostic_phone_runs WHERE phone_id = ?").get(phoneId);
      const runId = ["create", "resume"].includes(kind) ? newDiagnosticId() : String(current?.run_id ?? newDiagnosticId());
      database.prepare(`INSERT INTO diagnostic_phone_runs VALUES (?, ?) ON CONFLICT DO UPDATE SET run_id = excluded.run_id`).run(phoneId, runId);
      const id = newDiagnosticId();
      database.prepare(`INSERT INTO diagnostic_operations (id, owner_id, phone_id, run_id, kind, started_at, release, observer_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ownerId, phoneId, runId, kind, new Date().toISOString(), release(), observer);
      starts.set(id, performance.now());
      return id;
    });
  }
  function current(ownerId: number, phoneId: string): string | undefined {
    if (!allowed(phoneId)) return;
    return safely(() => {
      const row = database.prepare(`SELECT id FROM diagnostic_operations WHERE owner_id = ? AND phone_id = ?
        AND kind IN ('create','resume','boot_retry') AND outcome = 'running' ORDER BY rowid DESC LIMIT 1`).get(ownerId, phoneId);
      return row ? String(row.id) : operation(ownerId, phoneId, "resume");
    });
  }
  function write(operationId: string | undefined, input: unknown): boolean {
    if (!operationId || !allowed()) return false;
    return safely(() => {
      const record = validateStep(input);
      if (!record) { diagnosticHealth.invalidRecords++; return false; }
      const remote = ["setup", "boot", "runner"].includes(record.producer);
      const row = database.prepare(`SELECT o.phone_id, o.release FROM diagnostic_operations o JOIN phones p ON p.id = o.phone_id
        WHERE o.id = ? AND (o.outcome = 'running' OR (? = 1 AND o.outcome IN ('succeeded','failed'))
          OR (o.kind = 'viewing_session' AND o.outcome = 'succeeded' AND ? = 1 AND EXISTS (
            SELECT 1 FROM diagnostic_steps WHERE operation_id = o.id AND step_id = ? AND outcome = 'running')))
        AND p.state != 'deleted' AND p.user_id = o.owner_id`).get(operationId, remote ? 1 : 0, record.outcome !== "running" ? 1 : 0, record.stepId);
      if (!row || !allowed(String(row.phone_id))) return false;
      const prior = database.prepare("SELECT outcome, record FROM diagnostic_steps WHERE operation_id = ? AND step_id = ?").get(operationId, record.stepId);
      if (prior) {
        const old = validateStep(JSON.parse(String(prior.record)));
        if (!old || old.producerRunId !== record.producerRunId || old.attempt !== record.attempt || old.sequence !== record.sequence
          || old.code !== record.code || old.startedAt !== record.startedAt) return false;
        if (prior.outcome !== "running") return true; // First terminal result wins, including duplicate batches.
      } else if (Number(database.prepare("SELECT count(*) AS n FROM diagnostic_steps WHERE operation_id = ?").get(operationId)!.n) >= 2048) {
        database.prepare("UPDATE diagnostic_operations SET dropped_records = dropped_records + 1 WHERE id = ?").run(operationId);
        diagnosticHealth.droppedRecords++;
        return true; // Deliberately dropped, so collectors can advance.
      }
      database.prepare(`INSERT INTO diagnostic_steps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(operation_id, step_id) DO UPDATE SET outcome = excluded.outcome, observed_at = excluded.observed_at, record = excluded.record
        WHERE diagnostic_steps.outcome = 'running'`).run(operationId, record.stepId, record.producer, record.producerRunId,
          record.sequence, record.code, record.attempt, record.outcome, new Date().toISOString(), JSON.stringify(record));
      if (record.outcome !== "running") aggregate(record, String(row.release));
      return true;
    }) ?? false;
  }
  function aggregate(r: Step, version: string) {
    // Bounded logarithmic duration buckets. Reports label percentiles as bucket upper bounds.
    const bucket = r.durationMs === undefined ? -1 : r.durationMs === 0 ? 0 : 2 ** Math.ceil(Math.log2(r.durationMs));
    database.prepare(`INSERT INTO diagnostic_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT DO UPDATE SET samples = samples + 1`).run(new Date().toISOString().slice(0, 10), version, r.code, r.outcome,
        r.quality, r.disposition ?? "unknown", r.bootMethod ?? "unknown", r.cause ?? "unknown", r.confidence ?? "unknown", bucket);
  }
  function finish(operationId: string | undefined, outcome: Outcome) {
    if (!operationId || !allowed()) return;
    safely(() => database.prepare(`UPDATE diagnostic_operations SET outcome = ?, finished_at = ? WHERE id = ? AND outcome = 'running'`)
      .run(outcome, new Date().toISOString(), operationId));
    starts.delete(operationId);
    sequences.delete(operationId);
  }
  function cancel(ownerId: number, phoneId: string, startupOnly = false) {
    if (!allowed(phoneId)) return;
    safely(() => {
      for (const row of database.prepare(`SELECT id FROM diagnostic_operations WHERE owner_id = ? AND phone_id = ? AND outcome = 'running'
        AND (? = 0 OR kind IN ('create','resume','boot_retry'))`).all(ownerId, phoneId, startupOnly ? 1 : 0)) {
        const id = String(row.id);
        for (const step of database.prepare("SELECT record FROM diagnostic_steps WHERE operation_id = ? AND outcome = 'running' LIMIT 2048").all(id)) {
          const record = validateStep(JSON.parse(String(step.record)));
          if (record) write(id, { ...record, finishedAt: new Date().toISOString(), outcome: "cancelled", quality: "missing", errorCode: "cancelled" });
        }
        finish(id, "cancelled");
      }
    });
  }
  function reconcile() {
    if (!allowed()) return;
    safely(() => {
      const abandoned = database.prepare("SELECT id, kind, phone_id FROM diagnostic_operations WHERE observer_id != ? AND outcome = 'running' LIMIT 100").all(observer);
      for (const row of abandoned) {
        if (!allowed(String(row.phone_id))) continue;
        store.mark(String(row.id), "observer_restart", { outcome: "unknown", errorCode: "coverage_missing", quality: "missing" });
        database.prepare("UPDATE diagnostic_operations SET observer_id = ? WHERE id = ?").run(observer, row.id);
        if (row.kind === "viewing_session") {
          store.mark(String(row.id), "coverage_gap", { outcome: "unknown", errorCode: "coverage_missing", quality: "missing" });
          for (const step of database.prepare("SELECT record FROM diagnostic_steps WHERE operation_id = ? AND producer = 'server' AND outcome = 'running' LIMIT 2048").all(row.id)) {
            const r = validateStep(JSON.parse(String(step.record)));
            if (r) write(String(row.id), { ...r, finishedAt: new Date().toISOString(), outcome: "interrupted", quality: "missing", errorCode: "observer_shutdown" });
          }
          finish(String(row.id), "interrupted");
        }
      }
      const rows = database.prepare(`SELECT s.operation_id, s.record FROM diagnostic_steps s JOIN diagnostic_operations o ON o.id = s.operation_id
        WHERE s.producer = 'server' AND s.producer_run_id != ? AND s.outcome = 'running' AND o.outcome = 'running' LIMIT 500`).all(observer);
      for (const row of rows) {
        const r = validateStep(JSON.parse(String(row.record)));
        if (r) {
          write(String(row.operation_id), { ...r, finishedAt: new Date().toISOString(), outcome: "interrupted", errorCode: "observer_shutdown", quality: "missing" });
          store.mark(String(row.operation_id), "observer_restart", { outcome: "unknown", errorCode: "coverage_missing", quality: "missing" });
        }
      }
    });
  }
  function prune() {
    if (!allowed()) return;
    safely(() => {
      for (const code of Object.keys(flushed) as (keyof typeof flushed)[]) {
        const delta = diagnosticHealth[code] - flushed[code];
        if (delta > 0) database.prepare("INSERT INTO diagnostic_health VALUES (?, ?) ON CONFLICT DO UPDATE SET count = count + excluded.count").run(code, delta);
        flushed[code] = diagnosticHealth[code];
      }
      const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
      database.prepare("DELETE FROM diagnostic_operations WHERE id IN (SELECT id FROM diagnostic_operations WHERE started_at < ? LIMIT 100)").run(cutoff);
      database.prepare("DELETE FROM diagnostic_daily WHERE rowid IN (SELECT rowid FROM diagnostic_daily WHERE day < ? LIMIT 500)").run(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10));
    });
  }
  const store = { operation, current, write, finish, cancel, reconcile, prune,
    sameRun(operationId: string | undefined) {
      if (!operationId || !allowed()) return false;
      return safely(() => !!database.prepare(`SELECT 1 FROM diagnostic_operations o JOIN diagnostic_phone_runs r ON r.phone_id = o.phone_id
        JOIN phones p ON p.id = o.phone_id WHERE o.id = ? AND o.run_id = r.run_id
        AND o.outcome IN ('running','succeeded') AND p.user_id = o.owner_id AND p.state = 'running'`).get(operationId)) ?? false;
    },
    active(operationId: string | undefined) {
      if (!operationId || !allowed()) return false;
      return safely(() => !!database.prepare(`SELECT 1 FROM diagnostic_operations o JOIN diagnostic_phone_runs r ON r.phone_id = o.phone_id
        WHERE o.id = ? AND o.run_id = r.run_id AND o.outcome = 'running'`).get(operationId)) ?? false;
    },
    providerAvailable(ownerId: number, phoneId: string) {
      if (!allowed(phoneId)) return;
      safely(() => {
        const id = current(ownerId, phoneId);
        if (!id || database.prepare("SELECT 1 FROM diagnostic_steps WHERE operation_id = ? AND code = 'provider_wait' LIMIT 1").get(id)) return;
        const start = starts.get(id);
        store.mark(id, "provider_wait", start === undefined ? { quality: "missing" }
          : { durationMs: Math.min(86400000, Math.round(performance.now() - start)), quality: "observed_interval" });
      });
    },
    observeStop(ownerId: number, phoneId: string, evidence: { state: string; idleTimeoutMin: number; lastUsedAt?: string }) {
      if (!allowed(phoneId)) return;
      safely(() => {
        if (database.prepare(`SELECT 1 FROM diagnostic_steps s JOIN diagnostic_operations o ON o.id = s.operation_id
          WHERE o.phone_id = ? AND s.code = 'provider_stop' AND o.run_id = (SELECT run_id FROM diagnostic_phone_runs WHERE phone_id = ?) LIMIT 1`).get(phoneId, phoneId)) return;
        const operationId = operation(ownerId, phoneId, "viewing_session");
        const intent = database.prepare(`SELECT o.id FROM diagnostic_operations o JOIN diagnostic_steps s ON s.operation_id = o.id
          WHERE o.phone_id = ? AND o.owner_id = ? AND o.kind IN ('stop','keep') AND s.code = 'github_stop' AND s.outcome = 'succeeded'
          AND o.run_id = (SELECT run_id FROM diagnostic_phone_runs WHERE phone_id = ?)
          ORDER BY o.rowid DESC LIMIT 1`).get(phoneId, ownerId, phoneId);
        const lastUsed = Date.parse(evidence.lastUsedAt ?? "");
        store.mark(operationId, "provider_stop", { providerState: evidence.state as "Shutdown", cause: intent ? "application_stop" : "unknown",
          confidence: intent ? "confirmed" : "unknown", idleTimeoutMin: evidence.idleTimeoutMin, evidenceSource: "configured",
          ...(Number.isFinite(lastUsed) ? { providerActivityAt: new Date(lastUsed).toISOString() } : {}) });
        cancel(ownerId, phoneId);
      });
    },
    cursor(operationId: string) {
      return safely(() => Number(database.prepare("SELECT sequence FROM diagnostic_cursors WHERE operation_id = ? AND producer_run_id = 'file'").get(operationId)?.sequence ?? 0)) ?? 0;
    },
    collect(operationId: string, value: unknown) {
      if (!allowed() || !value || typeof value !== "object") return;
      const batch = value as { cursor: number; records: unknown[]; dropped: number };
      if (Object.keys(value).some(k => !["cursor", "records", "dropped"].includes(k)) || !Number.isSafeInteger(batch.cursor)
        || batch.cursor < 0 || batch.cursor > 1048576 || !Array.isArray(batch.records) || batch.records.length > 32
        || !Number.isSafeInteger(batch.dropped) || batch.dropped < 0 || batch.dropped > 100000) { diagnosticHealth.invalidRecords++; return; }
      safely(() => {
        // A savepoint also works when reconciliation already holds a lifecycle transaction.
        database.exec("SAVEPOINT diagnostic_batch");
        try {
          for (const input of batch.records) {
            const r = validateStep(input);
            if (!r || !["setup", "boot", "runner"].includes(r.producer)) { diagnosticHealth.invalidRecords++; continue; }
            if (!write(operationId, r)) throw new Error("Progress commit failed");
          }
          database.prepare(`INSERT INTO diagnostic_cursors VALUES (?, 'file', ?)
            ON CONFLICT DO UPDATE SET sequence = max(sequence, excluded.sequence)`).run(operationId, batch.cursor);
          database.prepare("UPDATE diagnostic_operations SET dropped_records = max(dropped_records, ?) WHERE id = ?").run(batch.dropped, operationId);
          database.exec("RELEASE diagnostic_batch");
        } catch { database.exec("ROLLBACK TO diagnostic_batch; RELEASE diagnostic_batch"); diagnosticHealth.collectorFailures++; }
      });
    },
    scope<T>(operationId: string | undefined, work: () => T): T { return operationId ? context.run({ store, operationId }, work) : work(); },
    mark(operationId: string | undefined, code: StepCode, extra: Partial<Step> = {}) {
      const ts = new Date().toISOString();
      return write(operationId, { stepId: newDiagnosticId(), producer: "server", producerRunId: observer, sequence: operationId ? nextSequence(operationId) : 1,
        attempt: 1, code, startedAt: ts, finishedAt: ts, outcome: "succeeded", errorCode: "none", quality: "observed_interval", ...extra });
    },
  };
  return store;
}

export function progressCursor() {
  const scope = context.getStore();
  return scope ? scope.store.cursor(scope.operationId) : 0;
}
export function diagnosticOperation() { return context.getStore()?.operationId; }
export function collectProgress(batch: unknown) {
  const scope = context.getStore();
  if (scope) scope.store.collect(scope.operationId, batch);
}

/** Nested source durations use a monotonic clock; this function never retries work. */
export async function measure<T>(code: StepCode, work: () => Promise<T>, extra: Partial<Step> = {}): Promise<T> {
  const scope = context.getStore();
  if (!scope) return work();
  const started = performance.now();
  const r: Step = { stepId: newDiagnosticId(), parentStepId: scope.parentStepId, producer: "server", producerRunId: observer,
    sequence: nextSequence(scope.operationId), code, attempt: 1, startedAt: new Date().toISOString(), outcome: "running", errorCode: "none", quality: "exact", ...extra };
  scope.store.write(scope.operationId, r);
  try {
    const result = await context.run({ ...scope, parentStepId: r.stepId }, work);
    const http = result instanceof Response ? { httpStatus: result.status } : {};
    const command = result && typeof result === "object" && "code" in result && Number.isInteger(result.code)
      && Number(result.code) >= 0 && Number(result.code) <= 255 ? { exitCode: Number(result.code) } : {};
    const failed = (result instanceof Response && !result.ok) || (command.exitCode !== undefined && command.exitCode !== 0);
    scope.store.write(scope.operationId, { ...r, ...http, ...command, finishedAt: new Date().toISOString(),
      durationMs: Math.min(86400000, Math.round(performance.now() - started)), outcome: failed ? "failed" : "succeeded",
      errorCode: failed ? command.exitCode ? "command_failed" : "provider_unavailable" : "none" });
    return result;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const supplied = error && typeof error === "object" && "diagnosticCode" in error ? error.diagnosticCode : undefined;
    scope.store.write(scope.operationId, { ...r, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), outcome: "failed",
      errorCode: errorCodes.includes(supplied as ErrorCode) ? supplied : name === "TimeoutError" ? "timeout" : name === "AbortError" ? "cancelled"
        : code === "credential_lookup" ? "credential_unavailable" : ["relay_connect", "ssh_auth", "metadata_fetch", "tunnel_lookup", "port_wait"].includes(code)
          ? "connection_failed" : code === "command" ? "command_failed" : "unknown_failure" });
    throw error;
  }
}
