import "server-only";
import { waitUntil } from "@vercel/functions";
import { withLease, independentWork } from "../data/coordination.ts";
import type { SetupResult } from "./phone-setup.ts";
import { validIdle } from "../shared/idle.ts";
import { randomBytes } from "node:crypto";
import { transaction, type DatabaseQueries } from "../data/async-database.ts";
import { GitHubError, type Codespace, type createGitHubClient } from "../github/github.ts";
import { assertMutationRate } from "../data/rate-limit.ts";
import { emitEvent, type EventEmitter } from "../data/events.ts";
import type { Client } from "@libsql/client";
import { decidePhoneTransition, decideRunChanges } from "./phone-lifecycle.ts";
import { candidatePhoneName, PHONE_ID } from "../shared/phone-name.ts";
import { createDiagnostics, measure, newDiagnosticId } from "../diagnostics/diagnostics.ts";

type GitHub = ReturnType<typeof createGitHubClient>;
type StoredPhone = {
  id: string; codespace_name: string; state: string; state_detail: string | null;
  retention_min: number; last_started_at: string | null; last_stopped_at: string | null;
  cores: number | null; machine: string; idle_timeout_min: number;
  retention_at: string | null;
  stop_reason: string | null;
};
export class PhoneInputError extends Error {}

/** After this time with no matching Codespace on GitHub, an unconfirmed creation is treated as failed. */
export const UNCONFIRMED_CREATION_EXPIRY_MS = 30 * 60_000;

export function createPhoneService({ database, github, encrypt, clock = Date.now, maxPhones, setup, collectProgress, runner, disconnect, emit = (event, queries = database) => emitEvent(event, queries) }: {
  database: Client;
  /** Installs the emulator and runner in an Available codespace. Without it, phones stay booting. */
  /** Starts or checks phone setup. "working" means: ask again later. */
  setup?: (userId: number, codespaceName: string) => Promise<"ready" | "working" | SetupResult>;
  collectProgress?: (userId: number, codespaceName: string) => Promise<void>;
  runner?: (userId: number, id: string, path: "/boot" | "/stop", body: Record<string, unknown>) => Promise<Response>;
  disconnect?: (userId: number, id: string, codespaceName: string) => void;
  github: GitHub;
  encrypt: (value: string) => Uint8Array;
  clock?: () => number;
  maxPhones?: number;
  emit?: EventEmitter;
}) {
  if (maxPhones !== undefined && (!Number.isSafeInteger(maxPhones) || maxPhones < 1)) {
    throw new Error("EMULY_MAX_PHONES must be a positive integer or unset");
  }
  const busy = new Set<string>();
  const background = (work: Promise<unknown>) => {
    const settled = work.catch(() => { /* Reconciliation retries persisted state. */ });
    if (process.env.VERCEL) waitUntil(settled);
    else void settled;
  };
  const diagnostics = createDiagnostics(database);
  void diagnostics.reconcile();
  const iso = () => new Date(clock()).toISOString();
  const settingUp = new Set<string>();
  const setupRetryAt = new Map<string, number>();
  const setupStarted = new Set<string>();
  const SETUP_RETRY_MS = 10 * 60_000;
  const SETUP_CHECK_MS = 20_000;
  const SETUP_FAILURE_DETAIL = "Phone setup failed. Emuly tries again in about 10 minutes.";
  const booting = new Set<string>();

  const startBoot = (userId: number, id: string) => independentWork(() => withLease(database, `boot:${id}`, () => performBoot(userId, id)));
  async function performBoot(userId: number, id: string) {
    if (!runner || booting.has(id) || busy.has(id)) return;
    booting.add(id);
    const started = iso();
    let operationId: string | undefined;
    try {
      operationId = await diagnostics.current(userId, id);
      const claimed = await transaction(database, async queries => {
        if (busy.has(id)) return false;
        const changed = await queries.execute({ sql: `UPDATE phones SET android_state = 'booting', android_started_at = ?, android_error = NULL
          WHERE user_id = ? AND id = ? AND state = 'running' AND android_state != 'stopping'`, args: [started, userId, id] });
        if (!changed.rowsAffected) return false;
        await event(userId, id, "step", "Android starting", queries);
        return true;
      });
      if (!claimed) return;
      let booted = false;
      try {
        await diagnostics.scope(operationId, () => measure("android_boot", async () => {
          const result = await runner(userId, id, "/boot", operationId ? { diagnosticOperation: operationId } : {});
          if ((await result.json()).booted !== true) throw new Error("Android boot was not confirmed.");
        }));
        booted = true;
      } catch { /* Persist a fixed error message below; never expose runner output. */ }
      const changed = await transaction(database, async queries => {
        const result = await queries.execute({ sql: `UPDATE phones SET android_state = ?, android_error = ?
          WHERE user_id = ? AND id = ? AND state = 'running' AND android_state = 'booting' AND android_started_at = ?`,
          args: [booted ? "ready" : "failed", booted ? null : "Android boot failed. Retry boot.", userId, id, started] });
        if (result.rowsAffected) await event(userId, id, booted ? "step" : "error", booted
          ? `Android ready (took ${Math.round((clock() - Date.parse(started)) / 1000)} s)`
          : "Android boot failed: Android boot failed. Retry boot.", queries);
        return result.rowsAffected;
      });
      void diagnostics.finish(operationId, changed ? booted ? "succeeded" : "failed" : "cancelled");
    } finally {
      booting.delete(id);
      // Progress collection is independent of the readiness transaction.
      if (operationId && collectProgress) {
        const target = (await database.execute({ sql: "SELECT codespace_name FROM phones WHERE id = ? AND user_id = ? AND state = 'running'", args: [id, userId] })).rows[0];
        if (target) background(collectProgress(userId, String(target.codespace_name)));
      }
    }
  }

  const startSetup = (userId: number, id: string, codespaceName: string) => independentWork(() => withLease(database, `setup:${id}`, () => performSetup(userId, id, codespaceName)));
  async function performSetup(userId: number, id: string, codespaceName: string) {
    if (!setup || settingUp.has(id)) return;
    settingUp.add(id);
    try {
      const operationId = await diagnostics.current(userId, id);
      const attemptId = newDiagnosticId();
      const attempt = await transaction(database, async queries => {
        const current = await phone(userId, id, queries);
        if (current.state !== "booting" || current.codespace_name !== codespaceName) return;
        const saved = (await queries.execute({ sql: "SELECT attempt, retry_at, failed FROM phone_setup_attempts WHERE phone_id = ?", args: [id] })).rows[0];
        if (Math.max(Number(saved?.retry_at ?? 0), setupRetryAt.get(id) ?? 0) > clock()) return;
        const next = Number(saved?.attempt ?? 0) + 1;
        await queries.execute({ sql: `INSERT INTO phone_setup_attempts (phone_id, attempt, retry_at, operation_id, attempt_id) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(phone_id) DO UPDATE SET attempt = excluded.attempt, retry_at = excluded.retry_at,
            operation_id = excluded.operation_id, attempt_id = excluded.attempt_id, failed = 0`, args: [id, next, clock() + SETUP_CHECK_MS, operationId ?? null, attemptId] });
        if (!setupStarted.has(id) || saved?.failed) {
          await queries.execute({ sql: "UPDATE phones SET state_detail = ? WHERE user_id = ? AND id = ?", args: ["Installing Android and starting the runner. The first setup takes several minutes.", userId, id] });
          await event(userId, id, "step", "Phone setup started", queries);
        }
        return next;
      });
      if (attempt === undefined) return;
      setupStarted.add(id);
      let status: "ready" | "working" | "failed";
      try {
        status = await diagnostics.scope(operationId, () => measure("setup_check", async () => {
          const result = await setup(userId, codespaceName);
          const state = typeof result === "string" ? result : result.state;
          if (state === "failed") throw new Error("Phone setup failed.");
          return state;
        }, { attempt }));
      } catch { status = "failed"; }
      // Recheck the attempt and phone inside the transaction after the remote call.
      const committed = await transaction(database, async queries => {
        const current = (await queries.execute({ sql: `SELECT p.machine FROM phone_setup_attempts a JOIN phones p ON p.id = a.phone_id
          WHERE a.phone_id = ? AND a.attempt_id = ? AND p.state = 'booting' AND p.user_id = ? AND p.codespace_name = ?`, args: [id, attemptId, userId, codespaceName] })).rows[0];
        if (!current) return false;
        if (status !== "ready") {
          await queries.execute({ sql: "UPDATE phone_setup_attempts SET retry_at = ?, failed = ? WHERE phone_id = ? AND attempt_id = ?", args: [clock() + (status === "failed" ? SETUP_RETRY_MS : SETUP_CHECK_MS), status === "failed" ? 1 : 0, id, attemptId] });
          if (status === "failed") {
            await queries.execute({ sql: "UPDATE phones SET state_detail = ? WHERE user_id = ? AND id = ?", args: [SETUP_FAILURE_DETAIL, userId, id] });
            await event(userId, id, "error", "Phone setup failed.", queries);
          }
        } else {
          await queries.execute({ sql: "DELETE FROM phone_setup_attempts WHERE phone_id = ? AND attempt_id = ?", args: [id, attemptId] });
          await queries.execute({ sql: "UPDATE phones SET state = 'running', state_detail = NULL WHERE user_id = ? AND id = ?", args: [userId, id] });
          await event(userId, id, "step", "Phone runner ready", queries);
          await emit({ userId, type: "phone.ready", createdAt: iso(), data: {
            phone: { id, name: codespaceName, state: "running", machine: current.machine }, reason: "user" } }, queries);
        }
        return true;
      });
      if (!committed) return;
      if (status === "ready") {
        setupStarted.delete(id);
        setupRetryAt.delete(id);
        background(startBoot(userId, id));
      } else {
        setupRetryAt.set(id, clock() + (status === "failed" ? SETUP_RETRY_MS : SETUP_CHECK_MS));
        if (status === "failed") void diagnostics.mark(operationId, "retry_wait", { retryDelayMs: SETUP_RETRY_MS, errorCode: "unknown_failure", outcome: "failed" });
      }
    } finally { settingUp.delete(id); }
  }

  async function event(userId: number, phoneId: string | null, kind: string, message: string, queries: DatabaseQueries = database) {
    await queries.execute({ sql: "INSERT INTO events (user_id, phone_id, ts, kind, message) VALUES (?, ?, ?, ?, ?)", args: [userId, phoneId, iso(), kind, redact(message)] });
  }

  async function phone(userId: number, id: string, queries: DatabaseQueries = database): Promise<StoredPhone> {
    if (!PHONE_ID.test(id)) throw new PhoneInputError("Invalid phone ID");
    const row = (await queries.execute({ sql: "SELECT * FROM phones WHERE user_id = ? AND id = ? AND state != 'deleted'", args: [userId, id] })).rows[0] as unknown as StoredPhone | undefined;
    if (!row) throw new PhoneInputError("Phone not found");
    return row;
  }

  /** Random, readable ids such as `phone-quiet-falcon`, unique across all accounts. */
  async function newPhoneId(): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const id = candidatePhoneName(randomBytes(4).readUInt32BE(0));
      if (!(await database.execute({ sql: "SELECT 1 FROM phones WHERE id = ?", args: [id] })).rows[0]) return id;
    }
    return `phone-${randomBytes(8).toString("hex")}`;
  }

  async function outgoing(userId: number, id: string, type: string, extra: Record<string, unknown> = {}, queries: DatabaseQueries = database) {
    const row = (await queries.execute({ sql: "SELECT codespace_name, state, machine FROM phones WHERE id = ? AND user_id = ?", args: [id, userId] })).rows[0]!;
    await emit({ userId, type, createdAt: iso(), data: {
      phone: { id, name: row.codespace_name, state: row.state, machine: row.machine }, ...extra,
    } }, queries);
  }

  async function claim(userId: number, id: string | null, operation: string, reserve?: (queries: DatabaseQueries) => Promise<void>, bulk = false) {
    await transaction(database, async queries => {
      const user = (await queries.execute({ sql: "SELECT id FROM users WHERE id = ? AND blocked = 0", args: [userId] })).rows[0];
      if (!user) throw new PhoneInputError("Sign in again");
      if (!bulk) await assertMutationRate(queries, userId, operation === "create", clock);
      await reserve?.(queries);
      // Bulk and automatic actions must not use up the user's own rate limit.
      await event(userId, id, "action", `${operation} requested${bulk ? " (batch)" : ""}`, queries);
    });
  }

  async function trackRun(previous: StoredPhone, codespace: Codespace, state: string, source: string, queries: DatabaseQueries = database) {
    const open = (await queries.execute({ sql: "SELECT id, cores, started_at FROM runs WHERE phone_id = ? AND stopped_at IS NULL", args: [previous.id] })).rows[0] as unknown as { id: number; cores: number; started_at: string } | undefined;
    const changes = decideRunChanges({ previous, codespace, state, source, open, now: clock() });
    if (changes.close) await queries.execute({ sql: "UPDATE runs SET stopped_at = ? WHERE id = ?", args: [changes.close.stoppedAt, changes.close.id] });
    if (changes.create) await queries.execute({ sql: "INSERT INTO runs (phone_id, cores, started_at, source) VALUES (?, ?, ?, ?)", args: [previous.id, changes.create.cores, changes.create.startedAt, source] });
  }

  async function applyStored(userId: number, id: string, codespace: Codespace, source: string, queries: DatabaseQueries) {
    const previous = await phone(userId, id, queries);
    const isKeeping = await keeping(id, queries);
    const android = (await queries.execute({ sql: "SELECT android_state FROM phones WHERE id = ?", args: [id] })).rows[0];
    const failedSetup = (await queries.execute({ sql: "SELECT failed FROM phone_setup_attempts WHERE phone_id = ?", args: [id] })).rows[0]?.failed === 1;
    const { state, detail, lastStarted, lastStopped, retention } = decidePhoneTransition({
      previous, codespace, androidState: String(android?.android_state ?? ""),
      setupAvailable: Boolean(setup), setupFailure: failedSetup ? previous.state_detail ?? SETUP_FAILURE_DETAIL : undefined, now: clock(),
    });
    if (["stopped", "error"].includes(previous.state) && state === "booting") {
      await queries.execute({ sql: "UPDATE phones SET stop_reason = NULL WHERE id = ?", args: [id] });
    }

    await trackRun(previous, codespace, state, source, queries);
    if (["stopped", "deleted", "stopping"].includes(state)) {
      await queries.execute({ sql: "DELETE FROM phone_setup_attempts WHERE phone_id = ?", args: [id] });
      await queries.execute({ sql: "UPDATE phones SET android_state = 'idle', android_error = NULL WHERE id = ?", args: [id] });
    }
    await queries.execute({ sql: `UPDATE phones SET state = ?, state_detail = ?, last_started_at = ?, last_stopped_at = ?,
      retention_at = ?, cores = COALESCE(?, cores) WHERE user_id = ? AND id = ?`, args: [state, detail, lastStarted, lastStopped, retention, codespace.machine?.cpus ?? null, userId, id] });
    if (previous.state !== state) {
      await event(userId, id, "step", `Codespace ${codespace.state}`, queries);
      // A requested start already emitted before HTTP. Reconciliation catches external starts.
      const type = state === "booting" ? (source === "reconciled" ? "phone.starting" : undefined)
        : ({ running: "phone.ready", stopped: "phone.stopped", deleted: "phone.deleted", error: "phone.error" } as Record<string, string>)[state];
      if (type) await emit({ userId, type, createdAt: iso(), data: {
        phone: { id, name: previous.codespace_name, state, machine: previous.machine },
        reason: isKeeping ? "retention" : previous.stop_reason ?? (source === "reconciled" ? "github" : "user"),
        ...(state === "error" ? { message: detail } : {}),
      } }, queries);
      if (state === "stopped") await queries.execute({ sql: "UPDATE phones SET stop_reason = NULL WHERE id = ?", args: [id] });
    }
    return () => {
      if (["stopped", "error"].includes(previous.state) && state === "booting") void diagnostics.operation(userId, id, "resume");
      if (codespace.state === "Available" && previous.state !== "running") void diagnostics.providerAvailable(userId, id);
      if (["stopped", "deleted", "stopping"].includes(state)) {
        if (["ShuttingDown", "Shutdown", "Deleted", "Failed"].includes(codespace.state)) {
          void diagnostics.observeStop(userId, id, { state: codespace.state, idleTimeoutMin: previous.idle_timeout_min, lastUsedAt: codespace.last_used_at });
        }
        disconnect?.(userId, id, previous.codespace_name);
      }
      // Start setup only after the state and fan-out have committed.
      if (codespace.state === "Available" && state === "booting" && !isKeeping) background(startSetup(userId, id, codespace.name));
      else if (state !== "booting") setupRetryAt.delete(id);
    };
  }

  async function apply(userId: number, id: string, codespace: Codespace, source = "emuly") {
    const afterCommit = await transaction(database, queries => applyStored(userId, id, codespace, source, queries));
    afterCommit();
  }

  async function change(userId: number, id: string, operation: "start" | "stop", bulk = false, automatic = false) {
    const stored = await phone(userId, id);
    if ((await keeping(id))) throw new PhoneInputError("Keep it is in progress. Wait until the phone stops again.");
    if (operation === "stop" && stored.state === "stopping") return id;
    if (stored.codespace_name.startsWith("pending:")) throw new PhoneInputError("This phone has no codespace yet. Create a new phone.");
    if (busy.has(id)) throw new PhoneInputError("A phone request is already in progress. Try again shortly.");
    busy.add(id);
    let claimed = false;
    let diagnosticOperation: string | undefined;
    try {
      await claim(userId, id, automatic ? "auto-stop" : operation, undefined, bulk);
      claimed = true;
      if (operation === "stop") diagnosticOperation = await diagnostics.operation(userId, id, "stop");
      if (operation === "stop") diagnostics.mark(diagnosticOperation, "stop_intent", { initiator: automatic ? "hours_budget" : bulk ? "stop_all" : "owner" });
      const current = await github.getCodespace(userId, id);
      if (operation === "start") {
        if (["Available", "Starting", "Creating", "Provisioning", "Rebuilding"].includes(current.state)) {
          await apply(userId, id, current);
        } else {
          await apply(userId, id, current, "reconciled");
          await outgoing(userId, id, "phone.starting", { reason: "user" });
          diagnosticOperation = await diagnostics.operation(userId, id, "resume");
          const result = await diagnostics.scope(diagnosticOperation, () => measure("github_start", () => github.startCodespace(userId, id)));
          if (result) await apply(userId, id, result);
          await database.execute({ sql: "UPDATE phones SET last_started_at = ? WHERE user_id = ? AND id = ?", args: [iso(), userId, id] });
        }
      } else if (["Shutdown", "ShuttingDown"].includes(current.state)) {
        await apply(userId, id, current);
      } else {
        await apply(userId, id, current, "reconciled");
        if (runner) {
          await database.execute({ sql: "UPDATE phones SET android_state = 'stopping' WHERE id = ?", args: [id] });
          try {
            const result = await runner(userId, id, "/stop", {});
            if ((await result.json()).stopped !== true) throw new PhoneInputError("Android stop was not confirmed. Try Stop again.");
            await event(userId, id, "step", "Android graceful stop completed");
          } catch {
            if (stored.state === "running") {
              await database.execute({ sql: "UPDATE phones SET android_state = 'failed', android_error = ? WHERE id = ?", args: ["Android stop failed. Try Stop again.", id] });
              throw new PhoneInputError("Android stop failed. The codespace is still running. Try Stop again.");
            }
            await event(userId, id, "error", "Runner unavailable during setup; stopping without a snapshot.");
          }
        }
        await diagnostics.scope(diagnosticOperation, () => measure("github_stop", () => github.stopCodespace(userId, id)));
        void diagnostics.finish(diagnosticOperation, "succeeded");
        void diagnostics.cancel(userId, id, true);
        await transaction(database, async queries => {
        await queries.execute({ sql: "DELETE FROM phone_setup_attempts WHERE phone_id = ?", args: [id] });
        await queries.execute({ sql: "UPDATE phones SET stop_reason = ? WHERE id = ?", args: [automatic ? "hours_budget" : "user", id] });
        await queries.execute({ sql: "UPDATE phones SET state = 'stopping', state_detail = ? WHERE user_id = ? AND id = ?", args: [runner ? "Android stopped. GitHub is stopping the codespace." : "GitHub is stopping the codespace. Runner snapshot saving is not connected yet.", userId, id] });
        });
        disconnect?.(userId, id, stored.codespace_name);
      }
      await event(userId, id, "step", `${operation} accepted`);
      return id;
    } catch (error) {
      void diagnostics.finish(diagnosticOperation, "unknown");
      if (claimed) {
        if (operation === "stop") await database.execute({ sql: `UPDATE phones SET android_state = 'failed',
          android_error = 'Stop could not be confirmed. Try Stop again.' WHERE user_id = ? AND id = ? AND android_state = 'stopping'`, args: [userId, id] });
        const message = error instanceof GitHubError ? redact(error.message)
          : "The phone request could not be confirmed. Refresh to check its state before trying again.";
        await database.execute({ sql: "UPDATE phones SET state_detail = ? WHERE user_id = ? AND id = ?", args: [message, userId, id] });
        await event(userId, id, "error", message);
        if (operation === "start") await outgoing(userId, id, "phone.error", { message });
      }
      throw error;
    } finally { busy.delete(id); }
  }

  async function keeping(id: string, queries: DatabaseQueries = database) {
    return (await queries.execute({ sql: "SELECT * FROM phone_keeps WHERE phone_id = ?", args: [id] })).rows[0] as unknown as
      { phase: string; attempted_at: string | null } | undefined;
  }

  /** Durable stages avoid holding an HTTP request open while GitHub boots. */
  async function advanceKeep(userId: number, id: string, current: Codespace) {
    const request = await keeping(id);
    if (!request) return;
    if (["Deleted", "Failed"].includes(current.state)) {
      await database.execute({ sql: "DELETE FROM phone_keeps WHERE phone_id = ?", args: [id] });
      await event(userId, id, "error", `Keep it failed: GitHub reports ${current.state}.`);
      return;
    }
    if (request.phase === "stopping" && current.state === "Shutdown") {
      await transaction(database, async queries => {
        const deleted = await queries.execute({ sql: "DELETE FROM phone_keeps WHERE phone_id = ? AND phase = 'stopping'", args: [id] });
        if (!deleted.rowsAffected) return;
        const stored = await phone(userId, id, queries);
        await event(userId, id, "phone.kept", "Phone kept. GitHub retention countdown reset.", queries);
        await emit({ userId, type: "phone.kept", createdAt: iso(), data: {
          phone: { id, name: stored.codespace_name, state: stored.state, machine: stored.machine },
          retention_at: stored.retention_at,
        } }, queries);
        await queries.execute({ sql: "DELETE FROM phone_keeps WHERE phone_id = ?", args: [id] });
      });
      return;
    }
    const operation = current.state === "Available" ? "stop"
      : request.phase === "starting" && current.state === "Shutdown" ? "start" : null;
    if (!operation || (request.attempted_at && clock() - Date.parse(request.attempted_at) < 60_000)) return;
    // Persist intent before HTTP; a failed/uncertain response can be reconciled next tick.
    const reserved = await transaction(database, async queries => {
      const changed = await queries.execute({ sql: `UPDATE phone_keeps SET phase = ?, attempted_at = ?
        WHERE phone_id = ? AND phase = ? AND attempted_at IS ?`,
        args: [operation === "stop" ? "stopping" : "starting", iso(), id, request.phase, request.attempted_at] });
      if (!changed.rowsAffected) return false;
      await event(userId, id, "action", `Keep it: ${operation} requested`, queries);
      return true;
    });
    if (!reserved) return;
    try {
      if (operation === "start") {
        await outgoing(userId, id, "phone.starting", { reason: "retention" });
        const result = await github.startCodespace(userId, id);
        if (result) await apply(userId, id, result);
      } else {
        const operationId = await diagnostics.operation(userId, id, "keep");
        void diagnostics.mark(operationId, "stop_intent", { initiator: "retention" });
        await diagnostics.scope(operationId, () => measure("github_stop", () => github.stopCodespace(userId, id)));
        void diagnostics.finish(operationId, "succeeded");
        await database.execute({ sql: "UPDATE phones SET stop_reason = 'retention' WHERE id = ?", args: [id] });
        await database.execute({ sql: "UPDATE phones SET state = 'stopping' WHERE user_id = ? AND id = ?", args: [userId, id] });
      }
      await event(userId, id, "step", `Keep it: ${operation} accepted`);
    } catch (error) {
      await event(userId, id, "error", error instanceof GitHubError ? error.message : "Keep it could not be confirmed. Retrying on the next tick.");
      if (operation === "start") await outgoing(userId, id, "phone.error", {
        message: error instanceof GitHubError ? redact(error.message) : "Keep it could not be confirmed.",
      });
      throw error;
    }
  }

  async function keep(userId: number, id: string, automatic = false) {
    const stored = await phone(userId, id);
    if ((await keeping(id))) return id;
    if (stored.state !== "stopped" || stored.codespace_name.startsWith("pending:")) {
      throw new PhoneInputError("Only a stopped phone can be kept.");
    }
    if (busy.has(id)) throw new PhoneInputError("A phone request is already in progress. Try again shortly.");
    busy.add(id);
    try {
      await claim(userId, id, "keep", undefined, automatic);
      const current = await github.getCodespace(userId, id);
      await apply(userId, id, current, "reconciled");
      if (current.state !== "Shutdown") throw new PhoneInputError("This phone is no longer stopped. Refresh its state.");
      await database.execute({ sql: "INSERT OR IGNORE INTO phone_keeps (phone_id, phase, requested_at) VALUES (?, 'starting', ?)", args: [id, iso()] });
      await advanceKeep(userId, id, current);
      return id;
    } finally { busy.delete(id); }
  }

  async function unconfirmed(userId: number, queries: DatabaseQueries = database) {
    return (await queries.execute({ sql: `SELECT c.phone_id, c.display_name, c.requested_at FROM phone_creations c
      JOIN phones p ON p.id = c.phone_id WHERE p.user_id = ? AND p.state != 'deleted'
      AND c.outcome = 'unconfirmed'`, args: [userId] })).rows as unknown as { phone_id: string; display_name: string; requested_at: string }[];
  }

  /** Identity and outcome commit together, so a restart can always resume reconciliation. */
  async function confirmCreation(userId: number, id: string, space: Codespace, source = "reconciled") {
    const afterCommit = await transaction(database, async queries => {
      if ((await queries.execute({ sql: "SELECT outcome FROM phone_creations WHERE phone_id = ?", args: [id] })).rows[0]?.outcome !== "unconfirmed") {
        return;
      }
      await queries.execute({ sql: `UPDATE phones SET codespace_name = ?, codespace_id = ?,
        machine = COALESCE(?, machine), cores = COALESCE(?, cores) WHERE user_id = ? AND id = ?`, args: [space.name, String(space.id), space.machine?.name ?? null, space.machine?.cpus ?? null, userId, id] });
      const afterCommit = await applyStored(userId, id, space, source, queries);
      await queries.execute({ sql: "UPDATE phone_creations SET outcome = 'confirmed' WHERE phone_id = ?", args: [id] });
      await outgoing(userId, id, "phone.created", undefined, queries);
      return afterCommit;
    });
    afterCommit?.();
  }

  async function recoverCreations(userId: number, spaces: Codespace[]) {
    for (const operation of (await unconfirmed(userId))) {
      if (busy.has(operation.phone_id)) continue;
      const matches = spaces.filter(space => space.display_name === operation.display_name);
      // No match is not proof that a timed-out POST failed. Never submit a replacement automatically.
      // GitHub lists a new Codespace within minutes, so a long absence does prove failure.
      if (matches.length === 0 && clock() - Date.parse(operation.requested_at) >= UNCONFIRMED_CREATION_EXPIRY_MS) {
        await database.execute({ sql: "UPDATE phone_creations SET outcome = 'failed' WHERE phone_id = ? AND outcome = 'unconfirmed'", args: [operation.phone_id] });
        void diagnostics.cancel(userId, operation.phone_id, true);
        continue;
      }
      if (matches.length !== 1) continue;
      await confirmCreation(userId, operation.phone_id, matches[0]!);
    }
  }

  async function remove(userId: number, id: string) {
    await phone(userId, id);
    if (busy.has(id)) throw new PhoneInputError("A phone request is already in progress. Try again shortly.");
    busy.add(id);
    try {
      await claim(userId, id, "delete");
      const operationId = await diagnostics.operation(userId, id, "delete");
      await diagnostics.scope(operationId, () => measure("github_delete", () => github.deleteCodespace(userId, id)));
      void diagnostics.finish(operationId, "succeeded");
      const previous = await transaction(database, async queries => {
        const previous = await phone(userId, id, queries);
        await trackRun(previous, { id: 0, name: previous.codespace_name, state: "Deleted" }, "deleted", "emuly", queries);
        await queries.execute({ sql: "UPDATE phones SET state = 'deleted', state_detail = NULL WHERE user_id = ? AND id = ?", args: [userId, id] });
        await event(userId, id, "step", "delete accepted", queries);
        return previous;
      });
      disconnect?.(userId, id, previous.codespace_name);
      void diagnostics.cancel(userId, id);
      return id;
    } finally { busy.delete(id); }
  }

  const service = {
    async retryBoot(userId: number, id: string) {
      const stored = await phone(userId, id);
      if (stored.state !== "running" || (await keeping(id)) || busy.has(id) || booting.has(id)) throw new PhoneInputError("Wait until the phone is running.");
      await claim(userId, id, "retry boot");
      void diagnostics.operation(userId, id, "boot_retry", true);
      background(startBoot(userId, id));
      return id;
    },
    keep,
    remove,
    autoKeep: (userId: number, id: string) => keep(userId, id, true),
    machines: (userId: number, repository: string) => github.machines(userId, repository),
    async create(userId: number, input: { repository: string; repositoryId: number; machine?: string; idleTimeoutMin: number; devcontainerPath?: string }) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(input.repository) || !Number.isSafeInteger(input.repositoryId)
        || input.repositoryId <= 0 || !validIdle(input.idleTimeoutMin)
        || (input.devcontainerPath !== undefined && !/^\.?[\w./-]+\.json$/.test(input.devcontainerPath))
        || (input.machine !== undefined && !/^[\w-]{1,100}$/.test(input.machine))) {
        throw new PhoneInputError("Choose a valid repository, machine, and idle timeout.");
      }
      const interrupted = await unconfirmed(userId);
      if (interrupted.length) {
        if (!(await database.execute({ sql: "SELECT id FROM users WHERE id = ? AND blocked = 0", args: [userId] })).rows[0]) {
          throw new PhoneInputError("Sign in again");
        }
        await recoverCreations(userId, await github.listCodespaces(userId));
        if ((await unconfirmed(userId)).length) {
          throw new PhoneInputError("Phone creation is unconfirmed. Refresh to reconcile it before creating another phone.");
        }
      }
      const id = await newPhoneId();
      await claim(userId, id, "create", async queries => {
        if ((await unconfirmed(userId, queries)).length) throw new PhoneInputError("Phone creation is unconfirmed. Refresh before trying again.");
        if (maxPhones !== undefined) {
          const count = (await queries.execute({ sql: `SELECT count(*) AS n FROM phones WHERE user_id = ? AND state != 'deleted'
            AND (state != 'error' OR codespace_name NOT LIKE 'pending:%')`, args: [userId] })).rows[0]!.n as number;
          if (count >= maxPhones) throw new PhoneInputError("You reached the local operator's phone safety cap (EMULY_MAX_PHONES).");
        }
        await queries.execute({ sql: `INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state,
          created_at, runner_secret, idle_timeout_min, retention_min) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 43200)`, args: [id, userId, `pending:${id}`, input.repository, input.machine ?? "Choosing machine", iso(), encrypt(randomBytes(32).toString("base64url")), input.idleTimeoutMin] });
        await queries.execute({ sql: `INSERT INTO phone_creations (phone_id, display_name, outcome, requested_at)
          VALUES (?, ?, 'unconfirmed', ?)`, args: [id, id, iso()] });
      });
      busy.add(id);
      const operationId = await diagnostics.operation(userId, id, "create");
      void diagnostics.mark(operationId, "request_accepted");
      let submitted = false;
      try {
        const machines = await github.machines(userId, input.repository);
        const machine = input.machine ? machines.find(m => m.name === input.machine)
          : machines.find(m => m.name === "standardLinux32gb") ?? [...machines].sort((a, b) => b.cpus - a.cpus)[0];
        if (!machine) throw new PhoneInputError("The selected machine is unavailable for this repository.");
        await database.execute({ sql: "UPDATE phones SET machine = ?, cores = ? WHERE id = ?", args: [machine.name, machine.cpus, id] });
        submitted = true;
        const result = await diagnostics.scope(operationId, () => measure("github_create", () => github.createCodespace(userId, id, {
          repository_id: input.repositoryId, machine: machine.name, devcontainer_path: input.devcontainerPath,
          // The current plan chooses the API maximum for new phones; existing settings stay as recorded.
          // https://docs.github.com/en/rest/codespaces/codespaces#create-a-codespace-for-the-authenticated-user
          idle_timeout_minutes: input.idleTimeoutMin, retention_period_minutes: 43200,
        })));
        await database.execute({ sql: "UPDATE phones SET last_started_at = ? WHERE user_id = ? AND id = ?", args: [iso(), userId, id] });
        await confirmCreation(userId, id, result, "emuly");
        await event(userId, id, "step", "Phone created");
        return id;
      } catch (error) {
        // Only a definite rejection or a failure before POST proves that no Codespace was created.
        const failed = !submitted || (error instanceof GitHubError && error.status >= 400
          && error.status < 500 && error.status !== 408);
        const message = error instanceof GitHubError || error instanceof PhoneInputError ? redact(error.message)
          : "Phone creation is unconfirmed. Refresh to reconcile it before trying again.";
        await transaction(database, async queries => {
          if (failed) await queries.execute({ sql: "UPDATE phone_creations SET outcome = 'failed' WHERE phone_id = ?", args: [id] });
          await queries.execute({ sql: "UPDATE phones SET state = 'error', state_detail = ? WHERE user_id = ? AND id = ?", args: [message, userId, id] });
          await event(userId, id, "error", message, queries);
          await outgoing(userId, id, "phone.error", { message }, queries);
        });
        if (failed) void diagnostics.finish(operationId, "failed");
        throw error;
      } finally { busy.delete(id); }
    },
    start: (userId: number, id: string) => change(userId, id, "start"),
    stop: (userId: number, id: string) => change(userId, id, "stop"),
    autoStop: (userId: number, id: string) => change(userId, id, "stop", true, true),
    async sync(userId: number) {
      void diagnostics.reconcile();
      void diagnostics.prune();
      const rows = (await database.execute({ sql: "SELECT id, codespace_name, state FROM phones WHERE user_id = ? AND state != 'deleted'", args: [userId] })).rows as unknown as { id: string; codespace_name: string; state: string }[];
      if (!rows.some(row => !row.codespace_name.startsWith("pending:")) && !(await unconfirmed(userId)).length) return;
      const spaces = await github.listCodespaces(userId);
      await recoverCreations(userId, spaces);
      for (const row of rows) {
        const space = spaces.find(item => item.name === row.codespace_name);
        if (space && !busy.has(row.id)) {
          busy.add(row.id);
          try {
            if ((await phone(userId, row.id)).state !== row.state) continue;
            await apply(userId, row.id, space, "reconciled");
            await advanceKeep(userId, row.id, space);
          }
          finally { busy.delete(row.id); }
          const android = (await database.execute({ sql: "SELECT android_state FROM phones WHERE id = ? AND state = 'running'", args: [row.id] })).rows[0];
          // Recover a boot interrupted by a server restart. /boot is idempotent on the runner.
          if (android && ["idle", "booting"].includes(String(android.android_state))) background(startBoot(userId, row.id));
        }
        else if (!space && !row.codespace_name.startsWith("pending:") && !busy.has(row.id)) {
          await apply(userId, row.id, { id: 0, name: row.codespace_name, state: "Deleted" }, "reconciled");
          await database.execute({ sql: "DELETE FROM phone_keeps WHERE phone_id = ?", args: [row.id] });
        }
      }
    },
    async stopAll(userId: number) {
      await claim(userId, null, "stop all");
      const rows = (await database.execute({ sql: "SELECT id FROM phones WHERE user_id = ? AND state IN ('running', 'booting')", args: [userId] })).rows as unknown as { id: string }[];
      let stopped = 0;
      const errors: string[] = [];
      for (const row of rows) {
        try { await change(userId, row.id, "stop", true); stopped++; }
        catch (error) { errors.push(error instanceof Error ? redact(error.message) : "Stop could not be confirmed."); }
      }
      return { stopped, errors };
    },
  };
  return {
    ...service,
    create: (...args: Parameters<typeof service.create>) => withLease(database, `phones:${args[0]}`, () => service.create(...args)),
    start: (...args: Parameters<typeof service.start>) => withLease(database, `phones:${args[0]}`, () => service.start(...args)),
    stop: (...args: Parameters<typeof service.stop>) => withLease(database, `phones:${args[0]}`, () => service.stop(...args)),
    remove: (...args: Parameters<typeof service.remove>) => withLease(database, `phones:${args[0]}`, () => service.remove(...args)),
    keep: (...args: Parameters<typeof service.keep>) => withLease(database, `phones:${args[0]}`, () => service.keep(...args)),
    sync: (...args: Parameters<typeof service.sync>) => withLease(database, `phones:${args[0]}`, () => service.sync(...args)),
    stopAll: (...args: Parameters<typeof service.stopAll>) => withLease(database, `phones:${args[0]}`, () => service.stopAll(...args)),
    autoStop: (...args: Parameters<typeof service.autoStop>) => withLease(database, `phones:${args[0]}`, () => service.autoStop(...args)),
    autoKeep: (...args: Parameters<typeof service.autoKeep>) => withLease(database, `phones:${args[0]}`, () => service.autoKeep(...args)),
    retryBoot: (...args: Parameters<typeof service.retryBoot>) => withLease(database, `phones:${args[0]}`, () => service.retryBoot(...args)),
  };
}

export function redact(message: string) {
  return message.replace(/gh[opsu]_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/(authorization\s*[:=]\s*|cookie\s*[:=]\s*|runner_secret\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]");
}
