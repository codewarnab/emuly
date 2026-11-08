import "server-only";
import { validIdle } from "./idle.ts";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { GitHubError, type Codespace, type createGitHubClient } from "./github.ts";
import { assertMutationRate } from "./rate-limit.ts";
import { emitEvent, type EventEmitter } from "./events.ts";
import { retentionExpiry } from "./retention.ts";

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

export function createPhoneService({ database, github, encrypt, clock = Date.now, maxPhones, setup, runner, disconnect, emit = event => emitEvent(event, database) }: {
  database: DatabaseSync;
  /** Installs the emulator and runner in an Available codespace. Without it, phones stay booting. */
  /** Starts or checks phone setup. "working" means: ask again later. */
  setup?: (userId: number, codespaceName: string) => Promise<"ready" | "working">;
  runner?: (userId: number, id: string, path: "/boot" | "/stop", body: Record<string, unknown>) => Promise<Response>;
  disconnect?: (userId: number, id: string, codespaceName: string) => void;
  github: GitHub;
  encrypt: (value: string) => Uint8Array;
  clock?: () => number;
  maxPhones?: number;
  emit?: EventEmitter;
}) {
  if (maxPhones !== undefined && (!Number.isSafeInteger(maxPhones) || maxPhones < 1)) {
    throw new Error("PHONELINK_MAX_PHONES must be a positive integer or unset");
  }
  const busy = new Set<string>();
  const iso = () => new Date(clock()).toISOString();
  const settingUp = new Set<string>();
  const setupRetryAt = new Map<string, number>();
  const setupFailure = new Map<string, string>();
  const setupStarted = new Set<string>();
  const SETUP_RETRY_MS = 10 * 60_000;
  const SETUP_CHECK_MS = 20_000;
  const booting = new Set<string>();

  function startBoot(userId: number, id: string) {
    if (!runner || booting.has(id) || busy.has(id)) return;
    booting.add(id);
    const started = iso();
    database.prepare("UPDATE phones SET android_state = 'booting', android_started_at = ?, android_error = NULL WHERE user_id = ? AND id = ?")
      .run(started, userId, id);
    event(userId, id, "step", "Android starting");
    void (async () => {
      try {
        const result = await runner(userId, id, "/boot", { mode: "resume" });
        if ((await result.json()).booted !== true) throw new Error("Android did not finish booting. Retry boot.");
        const changed = database.prepare(`UPDATE phones SET android_state = 'ready', android_error = NULL
          WHERE user_id = ? AND id = ? AND state = 'running' AND android_state = 'booting' AND android_started_at = ?`)
          .run(userId, id, started);
        if (changed.changes) event(userId, id, "step", `Android ready (took ${Math.round((clock() - Date.parse(started)) / 1000)} s)`);
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : "Android boot failed.").slice(0, 500);
        const changed = database.prepare(`UPDATE phones SET android_state = 'failed', android_error = ?
          WHERE user_id = ? AND id = ? AND state = 'running' AND android_state = 'booting' AND android_started_at = ?`)
          .run(message, userId, id, started);
        if (changed.changes) event(userId, id, "error", `Android boot failed: ${message}`);
      } finally { booting.delete(id); }
    })();
  }

  function startSetup(userId: number, id: string, codespaceName: string) {
    if (!setup || settingUp.has(id) || (setupRetryAt.get(id) ?? 0) > clock()) return;
    settingUp.add(id);
    if (!setupStarted.has(id)) {
      setupStarted.add(id);
      database.prepare("UPDATE phones SET state_detail = ? WHERE user_id = ? AND id = ?")
        .run("Installing Android and starting the runner. The first setup takes several minutes.", userId, id);
      event(userId, id, "step", "Phone setup started");
    }
    // Each call is short: it starts setup in the codespace or checks on it.
    setup(userId, codespaceName).then(status => {
      if (status === "working") { setupRetryAt.set(id, clock() + SETUP_CHECK_MS); return; }
      setupStarted.delete(id);
      setupRetryAt.delete(id);
      setupFailure.delete(id);
      const current = database.prepare("SELECT state, codespace_name, machine FROM phones WHERE user_id = ? AND id = ?")
        .get(userId, id) as { state: string; codespace_name: string; machine: string } | undefined;
      // The phone may have stopped or been deleted while setup ran.
      if (current?.state !== "booting" || current.codespace_name !== codespaceName) return;
      database.prepare("UPDATE phones SET state = 'running', state_detail = NULL WHERE user_id = ? AND id = ?").run(userId, id);
      event(userId, id, "step", "Phone ready");
      startBoot(userId, id);
      emit({ userId, type: "phone.ready", createdAt: iso(), data: {
        phone: { id, name: codespaceName, state: "running", machine: current.machine }, reason: "user" } });
    }, (error: unknown) => {
      setupRetryAt.set(id, clock() + SETUP_RETRY_MS);
      const message = redact(error instanceof Error ? error.message : "Phone setup failed.");
      const detail = `${message} phonelink tries again in about 10 minutes.`;
      setupFailure.set(id, detail);
      database.prepare("UPDATE phones SET state_detail = ? WHERE user_id = ? AND id = ? AND state = 'booting'")
        .run(detail, userId, id);
      event(userId, id, "error", message);
    }).finally(() => settingUp.delete(id));
  }

  function event(userId: number, phoneId: string | null, kind: string, message: string) {
    database.prepare("INSERT INTO events (user_id, phone_id, ts, kind, message) VALUES (?, ?, ?, ?, ?)")
      .run(userId, phoneId, iso(), kind, redact(message));
  }

  function phone(userId: number, id: string): StoredPhone {
    if (!/^phone-[a-f0-9]{4,32}$/.test(id)) throw new PhoneInputError("Invalid phone ID");
    const row = database.prepare("SELECT * FROM phones WHERE user_id = ? AND id = ? AND state != 'deleted'")
      .get(userId, id) as StoredPhone | undefined;
    if (!row) throw new PhoneInputError("Phone not found");
    return row;
  }

  function outgoing(userId: number, id: string, type: string, extra: Record<string, unknown> = {}) {
    const row = database.prepare("SELECT codespace_name, state, machine FROM phones WHERE id = ? AND user_id = ?").get(id, userId)!;
    emit({ userId, type, createdAt: iso(), data: {
      phone: { id, name: row.codespace_name, state: row.state, machine: row.machine }, ...extra,
    } });
  }

  function claim(userId: number, id: string | null, operation: string, reserve?: () => void, bulk = false) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const user = database.prepare("SELECT id FROM users WHERE id = ? AND blocked = 0").get(userId);
      if (!user) throw new PhoneInputError("Sign in again");
      if (!bulk) assertMutationRate(database, userId, operation === "create", clock);
      reserve?.();
      // Bulk and automatic actions must not use up the user's own rate limit.
      event(userId, id, "action", `${operation} requested${bulk ? " (batch)" : ""}`);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }

  function trackRun(previous: StoredPhone, codespace: Codespace, state: string, source: string) {
    const open = database.prepare("SELECT id, cores, started_at FROM runs WHERE phone_id = ? AND stopped_at IS NULL")
      .get(previous.id) as { id: number; cores: number; started_at: string } | undefined;
    const active = ["Available", "Starting", "Creating", "Provisioning", "Rebuilding"].includes(codespace.state);
    const cores = codespace.machine?.cpus ?? previous.cores ?? (previous.machine === "basicLinux32gb" ? 2 : 4);
    if (open && (state === "stopped" || state === "deleted" || (active && open.cores !== cores))) {
      // last_used_at is activity, not a stop timestamp. Add the chosen idle window.
      const idleEnd = Date.parse(codespace.last_used_at ?? "") + previous.idle_timeout_min * 60_000;
      const end = state === "stopped" && source === "reconciled" && previous.state !== "stopping" && Number.isFinite(idleEnd)
        ? Math.max(Date.parse(open.started_at), Math.min(clock(), idleEnd)) : clock();
      database.prepare("UPDATE runs SET stopped_at = ? WHERE id = ?").run(new Date(end).toISOString(), open.id);
    }
    if (active && (!open || open.cores !== cores)) {
      const lastUsed = Date.parse(codespace.last_used_at ?? "");
      const knownStart = ["running", "booting"].includes(previous.state) ? Date.parse(previous.last_started_at ?? "") : lastUsed;
      const started = !open && source === "reconciled" && Number.isFinite(knownStart)
        ? Math.max(Date.parse(previous.last_stopped_at ?? "") || 0, Math.min(clock(), knownStart)) : clock();
      database.prepare("INSERT INTO runs (phone_id, cores, started_at, source) VALUES (?, ?, ?, ?)")
        .run(previous.id, cores, new Date(started).toISOString(), source);
    }
  }

  function apply(userId: number, id: string, codespace: Codespace, source = "phonelink") {
    const previous = phone(userId, id);
    const mapped = phoneState(codespace.state);
    const android = database.prepare("SELECT android_state FROM phones WHERE id = ?").get(id);
    const needsSetup = setup && android?.android_state === "idle";
    const state = codespace.state === "Available" && previous.state === "running" && !needsSetup ? "running"
      : previous.state === "stopping" && ["booting", "stopping"].includes(mapped) ? "stopping" : mapped;
    const started = ["Available", "Starting"].includes(codespace.state);
    const lastStarted = started && ["stopped", "error"].includes(previous.state) ? iso() : previous.last_started_at;
    const lastStopped = state === "stopped" && previous.state !== "stopped" ? iso() : previous.last_stopped_at;
    const retention = state === "stopped" ? retentionExpiry({ ...previous, last_stopped_at: lastStopped,
      retention_at: codespace.retention_expires_at ?? (previous.state === "stopped" ? previous.retention_at : null) }) : null;
    const detail = state === "running" ? null : codespace.state === "Available"
      ? (setupFailure.get(id) ?? (setup ? "Installing Android and starting the runner. The first setup takes several minutes."
        : "Codespace available. Phone setup is not connected yet."))
      : state === "error" ? `GitHub reports ${codespace.state}. Check the codespace on GitHub.` : null;
    trackRun(previous, codespace, state, source);
    if (["stopped", "deleted", "stopping"].includes(state)) {
      database.prepare("UPDATE phones SET android_state = 'idle', android_error = NULL WHERE id = ?").run(id);
      disconnect?.(userId, id, previous.codespace_name);
    }
    database.prepare(`UPDATE phones SET state = ?, state_detail = ?, last_started_at = ?, last_stopped_at = ?,
      retention_at = ?, cores = COALESCE(?, cores) WHERE user_id = ? AND id = ?`)
      .run(state, detail, lastStarted, lastStopped, retention, codespace.machine?.cpus ?? null, userId, id);
    if (previous.state !== state) {
      event(userId, id, "step", `Codespace ${codespace.state}`);
      // A requested start already emitted before HTTP. Reconciliation catches external starts.
      const type = state === "booting" ? (source === "reconciled" ? "phone.starting" : undefined)
        : ({ running: "phone.ready", stopped: "phone.stopped", deleted: "phone.deleted", error: "phone.error" } as Record<string, string>)[state];
      if (type) emit({ userId, type, createdAt: iso(), data: {
        phone: { id, name: previous.codespace_name, state, machine: previous.machine },
        reason: keeping(id) ? "retention" : previous.stop_reason ?? (source === "reconciled" ? "github" : "user"),
        ...(state === "error" ? { message: detail } : {}),
      } });
      if (state === "stopped") database.prepare("UPDATE phones SET stop_reason = NULL WHERE id = ?").run(id);
    }
    // Keep it only starts a phone to stop it again; it does not need the emulator.
    if (codespace.state === "Available" && state === "booting" && !keeping(id)) startSetup(userId, id, codespace.name);
    else if (state !== "booting") { setupRetryAt.delete(id); setupFailure.delete(id); }
  }

  async function change(userId: number, id: string, operation: "start" | "stop", bulk = false, automatic = false) {
    const stored = phone(userId, id);
    if (keeping(id)) throw new PhoneInputError("Keep it is in progress. Wait until the phone stops again.");
    if (operation === "stop" && stored.state === "stopping") return id;
    if (stored.codespace_name.startsWith("pending:")) throw new PhoneInputError("This phone has no codespace yet. Create a new phone.");
    if (busy.has(id)) throw new PhoneInputError("A phone request is already in progress. Try again shortly.");
    busy.add(id);
    let claimed = false;
    try {
      claim(userId, id, automatic ? "auto-stop" : operation, undefined, bulk);
      claimed = true;
      const current = await github.getCodespace(userId, id);
      if (operation === "start") {
        if (["Available", "Starting", "Creating", "Provisioning", "Rebuilding"].includes(current.state)) {
          apply(userId, id, current);
        } else {
          apply(userId, id, current, "reconciled");
          outgoing(userId, id, "phone.starting", { reason: "user" });
          const result = await github.startCodespace(userId, id);
          if (result) apply(userId, id, result);
          database.prepare("UPDATE phones SET last_started_at = ? WHERE user_id = ? AND id = ?").run(iso(), userId, id);
        }
      } else if (["Shutdown", "ShuttingDown"].includes(current.state)) {
        apply(userId, id, current);
      } else {
        apply(userId, id, current, "reconciled");
        if (runner) {
          database.prepare("UPDATE phones SET android_state = 'stopping' WHERE id = ?").run(id);
          try {
            const result = await runner(userId, id, "/stop", {});
            if ((await result.json()).stopped !== true) throw new PhoneInputError("Android stop was not confirmed. Try Stop again.");
            event(userId, id, "step", "Android graceful stop completed");
          } catch {
            if (stored.state === "running") {
              database.prepare("UPDATE phones SET android_state = 'failed', android_error = ? WHERE id = ?")
                .run("Android stop failed. Try Stop again.", id);
              throw new PhoneInputError("Android stop failed. The codespace is still running. Try Stop again.");
            }
            event(userId, id, "error", "Runner unavailable during setup; stopping without a snapshot.");
          }
        }
        await github.stopCodespace(userId, id);
        disconnect?.(userId, id, stored.codespace_name);
        database.prepare("UPDATE phones SET stop_reason = ? WHERE id = ?").run(automatic ? "hours_budget" : "user", id);
        database.prepare("UPDATE phones SET state = 'stopping', state_detail = ? WHERE user_id = ? AND id = ?")
          .run(runner ? "Android stopped. GitHub is stopping the codespace." : "GitHub is stopping the codespace. Runner snapshot saving is not connected yet.", userId, id);
      }
      event(userId, id, "step", `${operation} accepted`);
      return id;
    } catch (error) {
      if (claimed) {
        if (operation === "stop") database.prepare(`UPDATE phones SET android_state = 'failed',
          android_error = 'Stop could not be confirmed. Try Stop again.' WHERE user_id = ? AND id = ? AND android_state = 'stopping'`)
          .run(userId, id);
        const message = error instanceof GitHubError ? redact(error.message)
          : "The phone request could not be confirmed. Refresh to check its state before trying again.";
        database.prepare("UPDATE phones SET state_detail = ? WHERE user_id = ? AND id = ?").run(message, userId, id);
        event(userId, id, "error", message);
        if (operation === "start") outgoing(userId, id, "phone.error", { message });
      }
      throw error;
    } finally { busy.delete(id); }
  }

  function keeping(id: string) {
    return database.prepare("SELECT * FROM phone_keeps WHERE phone_id = ?").get(id) as
      { phase: string; attempted_at: string | null } | undefined;
  }

  /** Durable stages avoid holding an HTTP request open while GitHub boots. */
  async function advanceKeep(userId: number, id: string, current: Codespace) {
    const request = keeping(id);
    if (!request) return;
    if (["Deleted", "Failed"].includes(current.state)) {
      database.prepare("DELETE FROM phone_keeps WHERE phone_id = ?").run(id);
      event(userId, id, "error", `Keep it failed: GitHub reports ${current.state}.`);
      return;
    }
    if (request.phase === "stopping" && current.state === "Shutdown") {
      const stored = phone(userId, id);
      database.exec("BEGIN IMMEDIATE");
      try {
        event(userId, id, "phone.kept", "Phone kept. GitHub retention countdown reset.");
        emit({ userId, type: "phone.kept", createdAt: iso(), data: {
          phone: { id, name: stored.codespace_name, state: stored.state, machine: stored.machine },
          retention_at: stored.retention_at,
        } });
        database.prepare("DELETE FROM phone_keeps WHERE phone_id = ?").run(id);
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      return;
    }
    const operation = current.state === "Available" ? "stop"
      : request.phase === "starting" && current.state === "Shutdown" ? "start" : null;
    if (!operation || (request.attempted_at && clock() - Date.parse(request.attempted_at) < 60_000)) return;
    event(userId, id, "action", `Keep it: ${operation} requested`);
    // Persist intent before HTTP; a failed/uncertain response can be reconciled next tick.
    database.prepare("UPDATE phone_keeps SET phase = ?, attempted_at = ? WHERE phone_id = ?")
      .run(operation === "stop" ? "stopping" : "starting", iso(), id);
    try {
      if (operation === "start") {
        outgoing(userId, id, "phone.starting", { reason: "retention" });
        const result = await github.startCodespace(userId, id);
        if (result) apply(userId, id, result);
      } else {
        await github.stopCodespace(userId, id);
        database.prepare("UPDATE phones SET stop_reason = 'retention' WHERE id = ?").run(id);
        database.prepare("UPDATE phones SET state = 'stopping' WHERE user_id = ? AND id = ?").run(userId, id);
      }
      event(userId, id, "step", `Keep it: ${operation} accepted`);
    } catch (error) {
      event(userId, id, "error", error instanceof GitHubError ? error.message : "Keep it could not be confirmed. Retrying on the next tick.");
      if (operation === "start") outgoing(userId, id, "phone.error", {
        message: error instanceof GitHubError ? redact(error.message) : "Keep it could not be confirmed.",
      });
      throw error;
    }
  }

  async function keep(userId: number, id: string, automatic = false) {
    const stored = phone(userId, id);
    if (keeping(id)) return id;
    if (stored.state !== "stopped" || stored.codespace_name.startsWith("pending:")) {
      throw new PhoneInputError("Only a stopped phone can be kept.");
    }
    if (busy.has(id)) throw new PhoneInputError("A phone request is already in progress. Try again shortly.");
    busy.add(id);
    try {
      claim(userId, id, "keep", undefined, automatic);
      const current = await github.getCodespace(userId, id);
      apply(userId, id, current, "reconciled");
      if (current.state !== "Shutdown") throw new PhoneInputError("This phone is no longer stopped. Refresh its state.");
      database.prepare("INSERT INTO phone_keeps (phone_id, phase, requested_at) VALUES (?, 'starting', ?)").run(id, iso());
      await advanceKeep(userId, id, current);
      return id;
    } finally { busy.delete(id); }
  }

  function unconfirmed(userId: number) {
    return database.prepare(`SELECT c.phone_id, c.display_name, c.requested_at FROM phone_creations c
      JOIN phones p ON p.id = c.phone_id WHERE p.user_id = ? AND p.state != 'deleted'
      AND c.outcome = 'unconfirmed'`).all(userId) as { phone_id: string; display_name: string; requested_at: string }[];
  }

  /** Identity and outcome commit together, so a restart can always resume reconciliation. */
  function confirmCreation(userId: number, id: string, space: Codespace, source = "reconciled") {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (database.prepare("SELECT outcome FROM phone_creations WHERE phone_id = ?").get(id)?.outcome !== "unconfirmed") {
        database.exec("COMMIT");
        return;
      }
      database.prepare(`UPDATE phones SET codespace_name = ?, codespace_id = ?,
        machine = COALESCE(?, machine), cores = COALESCE(?, cores) WHERE user_id = ? AND id = ?`)
        .run(space.name, String(space.id), space.machine?.name ?? null, space.machine?.cpus ?? null, userId, id);
      apply(userId, id, space, source);
      database.prepare("UPDATE phone_creations SET outcome = 'confirmed' WHERE phone_id = ?").run(id);
      outgoing(userId, id, "phone.created");
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }

  function recoverCreations(userId: number, spaces: Codespace[]) {
    for (const operation of unconfirmed(userId)) {
      if (busy.has(operation.phone_id)) continue;
      const matches = spaces.filter(space => space.display_name === operation.display_name);
      // No match is not proof that a timed-out POST failed. Never submit a replacement automatically.
      // GitHub lists a new Codespace within minutes, so a long absence does prove failure.
      if (matches.length === 0 && clock() - Date.parse(operation.requested_at) >= UNCONFIRMED_CREATION_EXPIRY_MS) {
        database.prepare("UPDATE phone_creations SET outcome = 'failed' WHERE phone_id = ? AND outcome = 'unconfirmed'")
          .run(operation.phone_id);
        continue;
      }
      if (matches.length !== 1) continue;
      confirmCreation(userId, operation.phone_id, matches[0]!);
    }
  }

  async function remove(userId: number, id: string) {
    phone(userId, id);
    if (busy.has(id) || settingUp.has(id)) throw new PhoneInputError("A phone request is already in progress. Try again shortly.");
    busy.add(id);
    try {
      claim(userId, id, "delete");
      await github.deleteCodespace(userId, id);
      const previous = phone(userId, id);
      trackRun(previous, { id: 0, name: previous.codespace_name, state: "Deleted" }, "deleted", "phonelink");
      disconnect?.(userId, id, previous.codespace_name);
      database.prepare("UPDATE phones SET state = 'deleted', state_detail = NULL WHERE user_id = ? AND id = ?").run(userId, id);
      event(userId, id, "step", "delete accepted");
      return id;
    } finally { busy.delete(id); }
  }

  return {
    async retryBoot(userId: number, id: string) {
      const stored = phone(userId, id);
      if (stored.state !== "running" || keeping(id) || busy.has(id) || booting.has(id)) throw new PhoneInputError("Wait until the phone is running.");
      claim(userId, id, "retry boot");
      startBoot(userId, id);
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
      const interrupted = unconfirmed(userId);
      if (interrupted.length) {
        if (!database.prepare("SELECT id FROM users WHERE id = ? AND blocked = 0").get(userId)) {
          throw new PhoneInputError("Sign in again");
        }
        recoverCreations(userId, await github.listCodespaces(userId));
        if (unconfirmed(userId).length) {
          throw new PhoneInputError("Phone creation is unconfirmed. Refresh to reconcile it before creating another phone.");
        }
      }
      const id = `phone-${randomBytes(8).toString("hex")}`;
      claim(userId, id, "create", () => {
        if (unconfirmed(userId).length) throw new PhoneInputError("Phone creation is unconfirmed. Refresh before trying again.");
        if (maxPhones !== undefined) {
          const count = database.prepare(`SELECT count(*) AS n FROM phones WHERE user_id = ? AND state != 'deleted'
            AND (state != 'error' OR codespace_name NOT LIKE 'pending:%')`).get(userId)!.n as number;
          if (count >= maxPhones) throw new PhoneInputError("You reached the local operator's phone safety cap (PHONELINK_MAX_PHONES).");
        }
        database.prepare(`INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state,
          created_at, runner_secret, idle_timeout_min, retention_min) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 43200)`)
          .run(id, userId, `pending:${id}`, input.repository, input.machine ?? "Choosing machine", iso(),
            encrypt(randomBytes(32).toString("base64url")), input.idleTimeoutMin);
        database.prepare(`INSERT INTO phone_creations (phone_id, display_name, outcome, requested_at)
          VALUES (?, ?, 'unconfirmed', ?)`).run(id, id, iso());
      });
      busy.add(id);
      let submitted = false;
      try {
        const machines = await github.machines(userId, input.repository);
        const machine = input.machine ? machines.find(m => m.name === input.machine)
          : machines.find(m => m.name === "standardLinux32gb") ?? [...machines].sort((a, b) => b.cpus - a.cpus)[0];
        if (!machine) throw new PhoneInputError("The selected machine is unavailable for this repository.");
        database.prepare("UPDATE phones SET machine = ?, cores = ? WHERE id = ?").run(machine.name, machine.cpus, id);
        submitted = true;
        const result = await github.createCodespace(userId, id, {
          repository_id: input.repositoryId, machine: machine.name, devcontainer_path: input.devcontainerPath,
          // The current plan chooses the API maximum for new phones; existing settings stay as recorded.
          // https://docs.github.com/en/rest/codespaces/codespaces#create-a-codespace-for-the-authenticated-user
          idle_timeout_minutes: input.idleTimeoutMin, retention_period_minutes: 43200,
        });
        database.prepare("UPDATE phones SET last_started_at = ? WHERE user_id = ? AND id = ?").run(iso(), userId, id);
        confirmCreation(userId, id, result, "phonelink");
        event(userId, id, "step", "Phone created");
        return id;
      } catch (error) {
        // Only a definite rejection or a failure before POST proves that no Codespace was created.
        const failed = !submitted || (error instanceof GitHubError && error.status >= 400
          && error.status < 500 && error.status !== 408);
        if (failed) database.prepare("UPDATE phone_creations SET outcome = 'failed' WHERE phone_id = ?").run(id);
        const message = error instanceof GitHubError || error instanceof PhoneInputError ? redact(error.message)
          : "Phone creation is unconfirmed. Refresh to reconcile it before trying again.";
        database.prepare("UPDATE phones SET state = 'error', state_detail = ? WHERE user_id = ? AND id = ?")
          .run(message, userId, id);
        event(userId, id, "error", message);
        outgoing(userId, id, "phone.error", { message });
        throw error;
      } finally { busy.delete(id); }
    },
    start: (userId: number, id: string) => change(userId, id, "start"),
    stop: (userId: number, id: string) => change(userId, id, "stop"),
    autoStop: (userId: number, id: string) => change(userId, id, "stop", true, true),
    async sync(userId: number) {
      const rows = database.prepare("SELECT id, codespace_name, state FROM phones WHERE user_id = ? AND state != 'deleted'")
        .all(userId) as { id: string; codespace_name: string; state: string }[];
      if (!rows.some(row => !row.codespace_name.startsWith("pending:")) && !unconfirmed(userId).length) return;
      const spaces = await github.listCodespaces(userId);
      recoverCreations(userId, spaces);
      for (const row of rows) {
        const space = spaces.find(item => item.name === row.codespace_name);
        if (space && !busy.has(row.id) && phone(userId, row.id).state === row.state) {
          busy.add(row.id);
          try { apply(userId, row.id, space, "reconciled"); await advanceKeep(userId, row.id, space); }
          finally { busy.delete(row.id); }
          const android = database.prepare("SELECT android_state FROM phones WHERE id = ? AND state = 'running'").get(row.id);
          // Recover a boot interrupted by a server restart. /boot is idempotent on the runner.
          if (android && ["idle", "booting"].includes(String(android.android_state))) startBoot(userId, row.id);
        }
        else if (!space && !row.codespace_name.startsWith("pending:") && !busy.has(row.id)) {
          apply(userId, row.id, { id: 0, name: row.codespace_name, state: "Deleted" }, "reconciled");
          database.prepare("DELETE FROM phone_keeps WHERE phone_id = ?").run(row.id);
        }
      }
    },
    async stopAll(userId: number) {
      claim(userId, null, "stop all");
      const rows = database.prepare("SELECT id FROM phones WHERE user_id = ? AND state IN ('running', 'booting')")
        .all(userId) as { id: string }[];
      let stopped = 0;
      const errors: string[] = [];
      for (const row of rows) {
        try { await change(userId, row.id, "stop", true); stopped++; }
        catch (error) { errors.push(error instanceof Error ? redact(error.message) : "Stop could not be confirmed."); }
      }
      return { stopped, errors };
    },
  };
}

function phoneState(state: string) {
  if (state === "Shutdown") return "stopped";
  if (state === "Deleted") return "deleted";
  if (state === "ShuttingDown") return "stopping";
  if (["Available", "Starting", "Creating", "Provisioning", "Rebuilding", "Queued", "Awaiting"].includes(state)) return "booting";
  return "error";
}

export function redact(message: string) {
  return message.replace(/gh[opsu]_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/(authorization\s*[:=]\s*|cookie\s*[:=]\s*|runner_secret\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]");
}
