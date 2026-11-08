import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./database.ts";
import { validateStep, type Step } from "./diagnostic-contract.ts";
import { createDiagnostics, measure } from "./diagnostics.ts";
import { diagnosticReport } from "./diagnostic-reports.ts";
import { phoneObservations } from "./phone/phone-observation.ts";
import { createDiagnosticBrowserApi } from "./diagnostic-browser-api.ts";

const ts = "2026-11-08T00:00:00.000Z";
const record: Step = { stepId: "a".repeat(32), producer: "setup", producerRunId: "b".repeat(32), sequence: 1,
  code: "sdk_packages", attempt: 1, startedAt: ts, outcome: "running", errorCode: "none", quality: "exact" };

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON"); migrate(database);
  database.exec(`INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
    VALUES (1, 1, 'synthetic-private-login', X'00', '', '${ts}', '${ts}'), (2, 2, 'other', X'00', '', '${ts}', '${ts}');
    INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state, created_at, runner_secret)
    VALUES ('phone-aaaa', 1, 'synthetic-private-codespace', 'private/repo', 'machine', 'running', '${ts}', X'00');`);
  const previous = process.env.PHONELINK_DIAGNOSTICS, target = process.env.PHONELINK_DIAGNOSTICS_PHONE;
  process.env.PHONELINK_DIAGNOSTICS = "1"; delete process.env.PHONELINK_DIAGNOSTICS_PHONE;
  return { database, store: createDiagnostics(database), close() {
    if (previous === undefined) delete process.env.PHONELINK_DIAGNOSTICS; else process.env.PHONELINK_DIAGNOSTICS = previous;
    if (target === undefined) delete process.env.PHONELINK_DIAGNOSTICS_PHONE; else process.env.PHONELINK_DIAGNOSTICS_PHONE = target;
    database.close();
  } };
}

test("telemetry admission rejects unknown fields, free text, malformed identifiers, and invalid bounds", () => {
  assert.ok(validateStep(record));
  for (const patch of [
    { message: "Bearer synthetic-token https://private.invalid/home/person" }, { meta: { headers: { cookie: "private" } } },
    { code: "apt stdout /home/person" }, { stepId: "private/repository" }, { durationMs: -1 }, { sequence: 100001 },
    { producer: "private@example.invalid" }, { errorCode: "ghp_synthetic_private_token" },
    { finishedAt: "2025-01-01T00:00:00.000Z", outcome: "failed" }, { outcome: "succeeded" },
  ]) assert.equal(validateStep({ ...record, ...patch }), undefined);
});

test("remote delivery commits a cursor with validated records, deduplicates completion, and cannot overwrite terminal results", () => {
  const f = fixture();
  try {
    const op = f.store.operation(1, "phone-aaaa", "create")!;
    f.store.collect(op, { records: [record], cursor: 200, dropped: 0 });
    assert.equal(f.store.cursor(op), 200);
    const terminal = { ...record, finishedAt: ts, durationMs: 17, outcome: "succeeded" };
    f.store.collect(op, { records: [terminal], cursor: 500, dropped: 0 });
    f.store.collect(op, { records: [terminal], cursor: 500, dropped: 0 });
    f.store.collect(op, { records: [{ ...terminal, outcome: "failed" }], cursor: 500, dropped: 0 });
    assert.equal(f.database.prepare("SELECT outcome FROM diagnostic_steps").get()?.outcome, "succeeded");
    assert.equal(f.database.prepare("SELECT sum(samples) AS n FROM diagnostic_daily").get()?.n, 1);
    f.store.collect(op, { records: [{ ...record, stepId: "c".repeat(32), sequence: 2 }, { ...record, message: "private" }], cursor: 900, dropped: 0 });
    assert.equal(f.store.cursor(op), 900);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM diagnostic_steps").get()?.n, 2);
    f.store.cancel(1, "phone-aaaa");
    assert.equal(f.store.write(op, { ...record, stepId: "d".repeat(32), sequence: 3 }), false);
  } finally { f.close(); }
});

test("measurement executes work once, survives unavailable telemetry storage, and disabling collection stops writes", async () => {
  const f = fixture();
  try {
    const op = f.store.operation(1, "phone-aaaa", "create")!;
    let calls = 0;
    f.database.exec("DROP TABLE diagnostic_steps");
    assert.equal(await f.store.scope(op, () => measure("github_create", async () => { calls++; return 42; })), 42);
    assert.equal(calls, 1);
    process.env.PHONELINK_DIAGNOSTICS = "0";
    assert.equal(f.store.operation(1, "phone-aaaa", "resume"), undefined);
    assert.equal(f.store.write(op, record), false);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM diagnostic_operations").get()?.n, 1);
  } finally { f.close(); }
});

test("browser ingestion binds milestones to an owned server attempt and exposes no diagnostic read method", async () => {
  const f = fixture();
  try {
    const observations = phoneObservations(f.database), attemptId = observations.issue({ userId: 1, id: "phone-aaaa" });
    let userId = 2;
    const api = createDiagnosticBrowserApi({ user: async () => ({ id: userId }),
      phone: (owner, id) => f.database.prepare("SELECT state FROM phones WHERE user_id = ? AND id = ?").get(owner, id) as { state: string } | undefined,
      observations });
    const body = { attemptId, code: "first_painted", durationMs: 37, visible: true, reason: "none" };
    const request = (patch = {}, origin = "https://app.invalid") => new Request("https://app.invalid/app/phones/phone-aaaa/timing", {
      method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...body, ...patch }) });
    assert.equal((await api(request(), "phone-aaaa")).status, 404);
    userId = 1;
    assert.equal((await api(request({}, "https://other.invalid"), "phone-aaaa")).status, 403);
    assert.equal((await api(request({ attemptId: "f".repeat(32) }), "phone-aaaa")).status, 400);
    assert.equal((await api(request({ clipboard: "synthetic private contents" }), "phone-aaaa")).status, 400);
    assert.equal((await api(request(), "phone-aaaa")).status, 204);
    assert.equal((await api(request(), "phone-aaaa")).status, 204);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM diagnostic_steps WHERE code = 'first_painted'").get()?.n, 1);
    assert.equal((await api(new Request("https://app.invalid"), "phone-aaaa")).status, 405);
    f.store.operation(1, "phone-aaaa", "resume", true);
    assert.equal((await api(request({ code: "first_decoded" }), "phone-aaaa")).status, 400);
  } finally { f.close(); }
});

test("local exports omit private linkage, timestamps, and rejected content; shutdown causes stay unknown without evidence", () => {
  const f = fixture();
  try {
    const op = f.store.operation(1, "phone-aaaa", "create")!;
    f.store.mark(op, "request_accepted");
    f.store.observeStop(1, "phone-aaaa", { state: "ShuttingDown", idleTimeoutMin: 30 });
    const report = diagnosticReport(f.database, "timeline", op);
    const text = JSON.stringify(report);
    for (const privateValue of ["phone-aaaa", "synthetic-private-login", "synthetic-private-codespace", "private/repo", op, ts]) assert.ok(!text.includes(privateValue));
    assert.match(text, /"cause":"unknown"/);
    assert.match(text, /"firstFrame":"missing"/);
    f.database.exec("DELETE FROM users WHERE id = 1");
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM diagnostic_operations").get()?.n, 0);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM diagnostic_steps").get()?.n, 0);
  } finally { f.close(); }
});
