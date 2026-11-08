import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Client } from "@libsql/client";
import { transaction, type DatabaseQueries } from "../data/async-database.ts";
import { errorCodes, validateStep, type Step, type StepCode, type Outcome, type OperationKind, type ErrorCode } from "./diagnostic-contract.ts";

type Scope = { store: Diagnostics; operationId: string; parentStepId?: string };
const context = new AsyncLocalStorage<Scope>();
export const newDiagnosticId = () => randomBytes(16).toString("hex");
const observer = newDiagnosticId();
const healthFlushes = new WeakMap<Client, typeof diagnosticHealth>();
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
function diagnosticQueries(database: DatabaseQueries, starts: Map<string, number>, flushed: typeof diagnosticHealth) {
  const allowed = (phoneId?: string) => process.env.PHONELINK_DIAGNOSTICS === "1"
    && (!phoneId || !process.env.PHONELINK_DIAGNOSTICS_PHONE || phoneId === process.env.PHONELINK_DIAGNOSTICS_PHONE);

  async function operation(ownerId: number, phoneId: string, kind: OperationKind, fresh = false): Promise<string | undefined> {
    if (!allowed(phoneId)) return;
    const phone = (await database.execute({ sql: "SELECT state FROM phones WHERE id = ? AND user_id = ? AND state != 'deleted'", args: [phoneId, ownerId] })).rows[0];
    if (!phone) return;
    const existing = (await database.execute({ sql: `SELECT id FROM diagnostic_operations WHERE owner_id = ? AND phone_id = ?
      AND kind = ? AND outcome = 'running' ORDER BY started_at DESC LIMIT 1`, args: [ownerId, phoneId, kind] })).rows[0];
    if (existing && !fresh) return String(existing.id);
    const current = (await database.execute({ sql: "SELECT run_id FROM diagnostic_phone_runs WHERE phone_id = ?", args: [phoneId] })).rows[0];
    const runId = ["create", "resume"].includes(kind) ? newDiagnosticId() : String(current?.run_id ?? newDiagnosticId());
    await database.execute({ sql: `INSERT INTO diagnostic_phone_runs VALUES (?, ?) ON CONFLICT DO UPDATE SET run_id = excluded.run_id`, args: [phoneId, runId] });
    const id = newDiagnosticId();
    await database.execute({ sql: `INSERT INTO diagnostic_operations (id, owner_id, phone_id, run_id, kind, started_at, release, observer_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: [id, ownerId, phoneId, runId, kind, new Date().toISOString(), release(), observer] });
    starts.set(id, performance.now());
    return id;
  }
  async function current(ownerId: number, phoneId: string): Promise<string | undefined> {
    if (!allowed(phoneId)) return;
    const row = (await database.execute({ sql: `SELECT id FROM diagnostic_operations WHERE owner_id = ? AND phone_id = ?
      AND kind IN ('create','resume','boot_retry') AND outcome = 'running' ORDER BY rowid DESC LIMIT 1`, args: [ownerId, phoneId] })).rows[0];
    return row ? String(row.id) : (await operation(ownerId, phoneId, "resume"));
  }
  async function write(operationId: string | undefined, input: unknown): Promise<boolean> {
    if (!operationId || !allowed()) return false;
    const record = validateStep(input);
    if (!record) { diagnosticHealth.invalidRecords++; return false; }
    const remote = ["setup", "boot", "runner"].includes(record.producer);
    const row = (await database.execute({ sql: `SELECT o.phone_id, o.release FROM diagnostic_operations o JOIN phones p ON p.id = o.phone_id
      WHERE o.id = ? AND (o.outcome = 'running' OR (? = 1 AND o.outcome IN ('succeeded','failed'))
        OR (o.kind = 'viewing_session' AND o.outcome = 'succeeded' AND ? = 1 AND EXISTS (
          SELECT 1 FROM diagnostic_steps WHERE operation_id = o.id AND step_id = ? AND outcome = 'running')))
      AND p.state != 'deleted' AND p.user_id = o.owner_id`, args: [operationId, remote ? 1 : 0, record.outcome !== "running" ? 1 : 0, record.stepId] })).rows[0];
    if (!row || !allowed(String(row.phone_id))) return false;
    const prior = (await database.execute({ sql: "SELECT outcome, record FROM diagnostic_steps WHERE operation_id = ? AND step_id = ?", args: [operationId, record.stepId] })).rows[0];
    if (prior) {
      const old = validateStep(JSON.parse(String(prior.record)));
      if (!old || old.producerRunId !== record.producerRunId || old.attempt !== record.attempt || old.sequence !== record.sequence
        || old.code !== record.code || old.startedAt !== record.startedAt) return false;
      if (prior.outcome !== "running") return true; // First terminal result wins, including duplicate batches.
    } else if (Number((await database.execute({ sql: "SELECT count(*) AS n FROM diagnostic_steps WHERE operation_id = ?", args: [operationId] })).rows[0]!.n) >= 2048) {
      await database.execute({ sql: "UPDATE diagnostic_operations SET dropped_records = dropped_records + 1 WHERE id = ?", args: [operationId] });
      diagnosticHealth.droppedRecords++;
      return true; // Deliberately dropped, so collectors can advance.
    }
    await database.execute({ sql: `INSERT INTO diagnostic_steps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_id, step_id) DO UPDATE SET outcome = excluded.outcome, observed_at = excluded.observed_at, record = excluded.record
      WHERE diagnostic_steps.outcome = 'running'`, args: [operationId, record.stepId, record.producer, record.producerRunId, record.sequence, record.code, record.attempt, record.outcome, new Date().toISOString(), JSON.stringify(record)] });
    if (record.outcome !== "running") await aggregate(record, String(row.release));
    return true;
  }
  async function aggregate(r: Step, version: string) {
    // Bounded logarithmic duration buckets. Reports label percentiles as bucket upper bounds.
    const bucket = r.durationMs === undefined ? -1 : r.durationMs === 0 ? 0 : 2 ** Math.ceil(Math.log2(r.durationMs));
    await database.execute({ sql: `INSERT INTO diagnostic_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT DO UPDATE SET samples = samples + 1`, args: [new Date().toISOString().slice(0, 10), version, r.code, r.outcome, r.quality, r.disposition ?? "unknown", r.bootMethod ?? "unknown", r.cause ?? "unknown", r.confidence ?? "unknown", bucket] });
  }
  async function finish(operationId: string | undefined, outcome: Outcome) {
    if (!operationId || !allowed()) return;
    await ((await database.execute({ sql: `UPDATE diagnostic_operations SET outcome = ?, finished_at = ? WHERE id = ? AND outcome = 'running'`, args: [outcome, new Date().toISOString(), operationId] })));
    starts.delete(operationId);
    sequences.delete(operationId);
  }
  async function cancel(ownerId: number, phoneId: string, startupOnly = false) {
    if (!allowed(phoneId)) return;
    for (const row of (await database.execute({ sql: `SELECT id FROM diagnostic_operations WHERE owner_id = ? AND phone_id = ? AND outcome = 'running'
      AND (? = 0 OR kind IN ('create','resume','boot_retry'))`, args: [ownerId, phoneId, startupOnly ? 1 : 0] })).rows) {
      const id = String(row.id);
      for (const step of (await database.execute({ sql: "SELECT record FROM diagnostic_steps WHERE operation_id = ? AND outcome = 'running' LIMIT 2048", args: [id] })).rows) {
        const record = validateStep(JSON.parse(String(step.record)));
        if (record) await write(id, { ...record, finishedAt: new Date().toISOString(), outcome: "cancelled", quality: "missing", errorCode: "cancelled" });
      }
      await finish(id, "cancelled");
    }
  }
  async function reconcile() {
    if (!allowed()) return;
    const abandoned = (await database.execute({ sql: "SELECT id, kind, phone_id FROM diagnostic_operations WHERE observer_id != ? AND outcome = 'running' LIMIT 100", args: [observer] })).rows;
    for (const row of abandoned) {
      if (!allowed(String(row.phone_id))) continue;
      await store.mark(String(row.id), "observer_restart", { outcome: "unknown", errorCode: "coverage_missing", quality: "missing" });
      await database.execute({ sql: "UPDATE diagnostic_operations SET observer_id = ? WHERE id = ?", args: [observer, row.id] });
      if (row.kind === "viewing_session") {
        await store.mark(String(row.id), "coverage_gap", { outcome: "unknown", errorCode: "coverage_missing", quality: "missing" });
        for (const step of (await database.execute({ sql: "SELECT record FROM diagnostic_steps WHERE operation_id = ? AND producer = 'server' AND outcome = 'running' LIMIT 2048", args: [row.id] })).rows) {
          const r = validateStep(JSON.parse(String(step.record)));
          if (r) await write(String(row.id), { ...r, finishedAt: new Date().toISOString(), outcome: "interrupted", quality: "missing", errorCode: "observer_shutdown" });
        }
        await finish(String(row.id), "interrupted");
      }
    }
    const rows = (await database.execute({ sql: `SELECT s.operation_id, s.record FROM diagnostic_steps s JOIN diagnostic_operations o ON o.id = s.operation_id
      WHERE s.producer = 'server' AND s.producer_run_id != ? AND s.outcome = 'running' AND o.outcome = 'running' LIMIT 500`, args: [observer] })).rows;
    for (const row of rows) {
      const r = validateStep(JSON.parse(String(row.record)));
      if (r) {
        await write(String(row.operation_id), { ...r, finishedAt: new Date().toISOString(), outcome: "interrupted", errorCode: "observer_shutdown", quality: "missing" });
        await store.mark(String(row.operation_id), "observer_restart", { outcome: "unknown", errorCode: "coverage_missing", quality: "missing" });
      }
    }
  }
  async function prune() {
    if (!allowed()) return;
    for (const code of Object.keys(flushed) as (keyof typeof flushed)[]) {
      const delta = diagnosticHealth[code] - flushed[code];
      if (delta > 0) await database.execute({ sql: "INSERT INTO diagnostic_health VALUES (?, ?) ON CONFLICT DO UPDATE SET count = count + excluded.count", args: [code, delta] });
      flushed[code] = diagnosticHealth[code];
    }
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
    await database.execute({ sql: "DELETE FROM diagnostic_operations WHERE id IN (SELECT id FROM diagnostic_operations WHERE started_at < ? LIMIT 100)", args: [cutoff] });
    await database.execute({ sql: "DELETE FROM diagnostic_daily WHERE rowid IN (SELECT rowid FROM diagnostic_daily WHERE day < ? LIMIT 500)", args: [new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)] });
  }
  const store = { operation, current, write, finish, cancel, reconcile, prune,
    async sameRun(operationId: string | undefined) {
      if (!operationId || !allowed()) return false;
      return await (!!(await database.execute({ sql: `SELECT 1 FROM diagnostic_operations o JOIN diagnostic_phone_runs r ON r.phone_id = o.phone_id
        JOIN phones p ON p.id = o.phone_id WHERE o.id = ? AND o.run_id = r.run_id
        AND o.outcome IN ('running','succeeded') AND p.user_id = o.owner_id AND p.state = 'running'`, args: [operationId] })).rows[0]) ?? false;
    },
    async active(operationId: string | undefined) {
      if (!operationId || !allowed()) return false;
      return await (!!(await database.execute({ sql: `SELECT 1 FROM diagnostic_operations o JOIN diagnostic_phone_runs r ON r.phone_id = o.phone_id
        WHERE o.id = ? AND o.run_id = r.run_id AND o.outcome = 'running'`, args: [operationId] })).rows[0]) ?? false;
    },
    async providerAvailable(ownerId: number, phoneId: string) {
      if (!allowed(phoneId)) return;
      const id = await current(ownerId, phoneId);
      if (!id || (await database.execute({ sql: "SELECT 1 FROM diagnostic_steps WHERE operation_id = ? AND code = 'provider_wait' LIMIT 1", args: [id] })).rows[0]) return;
      const start = starts.get(id);
      await store.mark(id, "provider_wait", start === undefined ? { quality: "missing" }
        : { durationMs: Math.min(86400000, Math.round(performance.now() - start)), quality: "observed_interval" });
    },
    async observeStop(ownerId: number, phoneId: string, evidence: { state: string; idleTimeoutMin: number; lastUsedAt?: string }) {
      if (!allowed(phoneId)) return;
      if ((await database.execute({ sql: `SELECT 1 FROM diagnostic_steps s JOIN diagnostic_operations o ON o.id = s.operation_id
        WHERE o.phone_id = ? AND s.code = 'provider_stop' AND o.run_id = (SELECT run_id FROM diagnostic_phone_runs WHERE phone_id = ?) LIMIT 1`, args: [phoneId, phoneId] })).rows[0]) return;
      const operationId = await operation(ownerId, phoneId, "viewing_session");
      const intent = (await database.execute({ sql: `SELECT o.id FROM diagnostic_operations o JOIN diagnostic_steps s ON s.operation_id = o.id
        WHERE o.phone_id = ? AND o.owner_id = ? AND o.kind IN ('stop','keep') AND s.code = 'github_stop' AND s.outcome = 'succeeded'
        AND o.run_id = (SELECT run_id FROM diagnostic_phone_runs WHERE phone_id = ?)
        ORDER BY o.rowid DESC LIMIT 1`, args: [phoneId, ownerId, phoneId] })).rows[0];
      const lastUsed = Date.parse(evidence.lastUsedAt ?? "");
      await store.mark(operationId, "provider_stop", { providerState: evidence.state as "Shutdown", cause: intent ? "application_stop" : "unknown",
        confidence: intent ? "confirmed" : "unknown", idleTimeoutMin: evidence.idleTimeoutMin, evidenceSource: "configured",
        ...(Number.isFinite(lastUsed) ? { providerActivityAt: new Date(lastUsed).toISOString() } : {}) });
      await cancel(ownerId, phoneId);
    },
    async cursor(operationId: string) {
      return await (Number((await database.execute({ sql: "SELECT sequence FROM diagnostic_cursors WHERE operation_id = ? AND producer_run_id = 'file'", args: [operationId] })).rows[0]?.sequence ?? 0)) ?? 0;
    },
    async collect(operationId: string, value: unknown) {
      if (!allowed() || !value || typeof value !== "object") return;
      const batch = value as { cursor: number; records: unknown[]; dropped: number };
      if (Object.keys(value).some(k => !["cursor", "records", "dropped"].includes(k)) || !Number.isSafeInteger(batch.cursor)
        || batch.cursor < 0 || batch.cursor > 1048576 || !Array.isArray(batch.records) || batch.records.length > 32
        || !Number.isSafeInteger(batch.dropped) || batch.dropped < 0 || batch.dropped > 100000) { diagnosticHealth.invalidRecords++; return; }
      // The public collector wraps records, aggregates, and cursor in one transaction.
      try {
        for (const input of batch.records) {
          const r = validateStep(input);
          if (!r || !["setup", "boot", "runner"].includes(r.producer)) { diagnosticHealth.invalidRecords++; continue; }
          if (!(await write(operationId, r))) throw new Error("Progress commit failed");
        }
        await database.execute({ sql: `INSERT INTO diagnostic_cursors VALUES (?, 'file', ?)
          ON CONFLICT DO UPDATE SET sequence = max(sequence, excluded.sequence)`, args: [operationId, batch.cursor] });
        await database.execute({ sql: "UPDATE diagnostic_operations SET dropped_records = max(dropped_records, ?) WHERE id = ?", args: [batch.dropped, operationId] });
      } catch (error) { diagnosticHealth.collectorFailures++; throw error; }
    },
    async mark(operationId: string | undefined, code: StepCode, extra: Partial<Step> = {}) {
      const ts = new Date().toISOString();
      return await write(operationId, { stepId: newDiagnosticId(), producer: "server", producerRunId: observer, sequence: operationId ? nextSequence(operationId) : 1,
        attempt: 1, code, startedAt: ts, finishedAt: ts, outcome: "succeeded", errorCode: "none", quality: "observed_interval", ...extra });
    },
  };
  return store;
}

// Calls from legacy lifecycle transactions enqueue before their synchronous commit.
// Serializing per client preserves diagnostic ordering without nesting transactions.
const pending = new WeakMap<Client, Promise<unknown>>();
export function createDiagnostics(database: Client) {
  const starts = new Map<string, number>();
  const flushed = healthFlushes.get(database) ?? { writeFailures: 0, invalidRecords: 0, droppedRecords: 0, collectorFailures: 0 };
  healthFlushes.set(database, flushed);
  type Queries = ReturnType<typeof diagnosticQueries>;
  function run<K extends keyof Queries>(method: K, args: Parameters<Queries[K]>): Promise<Awaited<ReturnType<Queries[K]>>> {
    const fallback = (["write", "mark", "active", "sameRun"].includes(method) ? false : method === "cursor" ? 0 : undefined) as Awaited<ReturnType<Queries[K]>>;
    if (process.env.PHONELINK_DIAGNOSTICS !== "1") return Promise.resolve(fallback);
    const task = (pending.get(database) ?? Promise.resolve()).then(async () => {
      const previousFlush = { ...flushed };
      try {
        return await transaction(database, async queries => {
          const store = diagnosticQueries(queries, starts, flushed);
          const call = store[method] as (...values: Parameters<Queries[K]>) => ReturnType<Queries[K]>;
          return await call(...args);
        });
      } catch {
        Object.assign(flushed, previousFlush);
        diagnosticHealth.writeFailures++;
        return fallback;
      }
    }) as Promise<Awaited<ReturnType<Queries[K]>>>;
    pending.set(database, task);
    return task;
  }
  const store = {
    operation: (...args: Parameters<Queries["operation"]>) => run("operation", args),
    current: (...args: Parameters<Queries["current"]>) => run("current", args),
    write: (...args: Parameters<Queries["write"]>) => run("write", args),
    finish: (...args: Parameters<Queries["finish"]>) => run("finish", args),
    cancel: (...args: Parameters<Queries["cancel"]>) => run("cancel", args),
    reconcile: (...args: Parameters<Queries["reconcile"]>) => run("reconcile", args),
    prune: (...args: Parameters<Queries["prune"]>) => run("prune", args),
    sameRun: (...args: Parameters<Queries["sameRun"]>) => run("sameRun", args),
    active: (...args: Parameters<Queries["active"]>) => run("active", args),
    providerAvailable: (...args: Parameters<Queries["providerAvailable"]>) => run("providerAvailable", args),
    observeStop: (...args: Parameters<Queries["observeStop"]>) => run("observeStop", args),
    cursor: (...args: Parameters<Queries["cursor"]>) => run("cursor", args),
    collect: (...args: Parameters<Queries["collect"]>) => run("collect", args),
    mark: (...args: Parameters<Queries["mark"]>) => run("mark", args),
    scope<T>(operationId: string | undefined, work: () => T): T {
      return operationId ? context.run({ store, operationId }, work) : work();
    },
  };
  return store;
}

export async function progressCursor() {
  const scope = context.getStore();
  return scope ? scope.store.cursor(scope.operationId) : 0;
}
export function diagnosticOperation() { return context.getStore()?.operationId; }
export async function collectProgress(batch: unknown) {
  const scope = context.getStore();
  if (scope) await scope.store.collect(scope.operationId, batch);
}

/** Nested source durations use a monotonic clock; this function never retries work. */
export async function measure<T>(code: StepCode, work: () => Promise<T>, extra: Partial<Step> = {}): Promise<T> {
  const scope = context.getStore();
  if (!scope) return work();
  const started = performance.now();
  const r: Step = { stepId: newDiagnosticId(), parentStepId: scope.parentStepId, producer: "server", producerRunId: observer,
    sequence: nextSequence(scope.operationId), code, attempt: 1, startedAt: new Date().toISOString(), outcome: "running", errorCode: "none", quality: "exact", ...extra };
  await scope.store.write(scope.operationId, r);
  try {
    const result = await context.run({ ...scope, parentStepId: r.stepId }, work);
    const http = result instanceof Response ? { httpStatus: result.status } : {};
    const command = result && typeof result === "object" && "code" in result && Number.isInteger(result.code)
      && Number(result.code) >= 0 && Number(result.code) <= 255 ? { exitCode: Number(result.code) } : {};
    const failed = (result instanceof Response && !result.ok) || (command.exitCode !== undefined && command.exitCode !== 0);
    await scope.store.write(scope.operationId, { ...r, ...http, ...command, finishedAt: new Date().toISOString(),
      durationMs: Math.min(86400000, Math.round(performance.now() - started)), outcome: failed ? "failed" : "succeeded",
      errorCode: failed ? command.exitCode ? "command_failed" : "provider_unavailable" : "none" });
    return result;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const supplied = error && typeof error === "object" && "diagnosticCode" in error ? error.diagnosticCode : undefined;
    await scope.store.write(scope.operationId, { ...r, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), outcome: "failed",
      errorCode: errorCodes.includes(supplied as ErrorCode) ? supplied : name === "TimeoutError" ? "timeout" : name === "AbortError" ? "cancelled"
        : code === "credential_lookup" ? "credential_unavailable" : ["relay_connect", "ssh_auth", "metadata_fetch", "tunnel_lookup", "port_wait"].includes(code)
          ? "connection_failed" : code === "command" ? "command_failed" : "unknown_failure" });
    throw error;
  }
}
