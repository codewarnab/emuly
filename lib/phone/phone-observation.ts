import type { DatabaseSync } from "node:sqlite";
import { createDiagnostics, newDiagnosticId } from "../diagnostics.ts";
import { diagnosticId, type Step, type StepCode } from "../diagnostic-contract.ts";

type Owner = { userId: number; id: string };
type Window = { operationId?: string; expires: number; inputUntil: number; lastInputSummary: number };
type BrowserAttempt = { owner: Owner; window: Window; expires: number; runId: string; sequence: number; reports: number;
  lastPresence: number; milestones: Set<string> };
const windows = new WeakMap<DatabaseSync, ReturnType<typeof createPhoneObservations>>();

/** In-memory presence expires after 75 seconds; it never affects keep-awake policy. */
export function phoneObservations(database: DatabaseSync) {
  let value = windows.get(database);
  if (!value) { value = createPhoneObservations(database); windows.set(database, value); }
  return value;
}
function createPhoneObservations(database: DatabaseSync) {
  const store = createDiagnostics(database);
  const viewing = new Map<string, Window>();
  const attempts = new Map<string, BrowserAttempt>();
  const enabled = (phone: Owner) => process.env.PHONELINK_DIAGNOSTICS === "1"
    && (!process.env.PHONELINK_DIAGNOSTICS_PHONE || process.env.PHONELINK_DIAGNOSTICS_PHONE === phone.id);
  function window(phone: Owner): Window {
    const key = `${phone.userId}:${phone.id}`, now = Date.now();
    for (const [id, w] of viewing) if (w.expires < now) { store.finish(w.operationId, "succeeded"); viewing.delete(id); }
    let w = viewing.get(key);
    if (w && !store.active(w.operationId)) { viewing.delete(key); w = undefined; }
    if (!w) {
      w = { operationId: store.operation(phone.userId, phone.id, "viewing_session", true), expires: now + 15 * 60000,
        inputUntil: 0, lastInputSummary: 0 };
      viewing.set(key, w);
    }
    return w;
  }
  function mark(phone: Owner, code: StepCode, extra: Partial<Step> = {}) {
    if (!enabled(phone)) return;
    const w = window(phone);
    store.mark(w.operationId, code, { recentInput: w.inputUntil > Date.now(), ...extra });
  }
  return {
    mark,
    scope<T>(phone: Owner, work: () => Promise<T>): Promise<T> { return enabled(phone) ? store.scope(window(phone).operationId, work) : work(); },
    input(phone: Owner) {
      if (!enabled(phone)) return;
      const w = window(phone);
      w.inputUntil = Date.now() + 60000;
      if (Date.now() - w.lastInputSummary >= 60000) {
        w.lastInputSummary = Date.now();
        store.mark(w.operationId, "input_summary", { recentInput: true });
      }
    },
    issue(phone: Owner) {
      if (!enabled(phone)) return;
      const now = Date.now();
      for (const [id, a] of attempts) if (a.expires < now) attempts.delete(id);
      if (attempts.size >= 1000) return;
      const id = newDiagnosticId();
      attempts.set(id, { owner: phone, window: window(phone), expires: now + 30 * 60000, runId: newDiagnosticId(),
        sequence: 0, reports: 0, lastPresence: 0, milestones: new Set() });
      mark(phone, "stream_authorization");
      return id;
    },
    ingest(phone: Owner, value: unknown): boolean {
      if (!enabled(phone) || !value || typeof value !== "object" || Array.isArray(value)) return false;
      const r = value as Record<string, unknown>;
      if (Object.keys(r).some(k => !["attemptId", "code", "durationMs", "visible", "reason"].includes(k)) || !diagnosticId(r.attemptId)) return false;
      const a = attempts.get(r.attemptId);
      if (!a || a.expires < Date.now() || a.owner.userId !== phone.userId || a.owner.id !== phone.id || a.reports >= 180) return false;
      if (!store.sameRun(a.window.operationId)) return false;
      if (!["first_decoded", "first_painted", "presence", "reconnect", "screenshot_fallback"].includes(String(r.code))) return false;
      if (!Number.isSafeInteger(r.durationMs) || Number(r.durationMs) < 0 || Number(r.durationMs) > 1800000
        || typeof r.visible !== "boolean" || !["none", "socket_closed", "decoder_failed", "queue_full", "hidden", "stale"].includes(String(r.reason))) return false;
      if (["first_decoded", "first_painted", "screenshot_fallback"].includes(String(r.code))) {
        if (a.milestones.has(String(r.code))) return true;
        a.milestones.add(String(r.code));
      } else if (Date.now() - a.lastPresence < 10000) return false;
      else a.lastPresence = Date.now();
      a.reports++;
      const w = window(phone), ts = new Date().toISOString();
      return store.write(w.operationId, { stepId: newDiagnosticId(), producer: "browser", producerRunId: a.runId, sequence: ++a.sequence,
        attempt: 1, startedAt: ts, finishedAt: ts, durationMs: r.durationMs, code: r.code, visible: r.visible,
        outcome: "succeeded", errorCode: r.reason, quality: "observed_interval", ...(r.code === "presence" ? { presenceLeaseMs: 75000 } : {}) });
    },
  };
}
