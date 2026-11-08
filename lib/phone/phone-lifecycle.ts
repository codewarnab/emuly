import { retentionExpiry } from "../data/retention.ts";

/** Snapshot needed to reconcile provider state; contains no persistence handles. */
type LifecyclePhone = {
  state: string; last_started_at: string | null; last_stopped_at: string | null;
  retention_at: string | null; retention_min: number;
};
type ProviderObservation = {
  state: string; last_used_at?: string; retention_expires_at?: string | null;
  machine?: { cpus: number } | null;
};

/** Decide persisted phone state from a provider observation at the supplied time.
 * The service retains responsibility for guards, writes, diagnostics and remote work.
 */
export function decidePhoneTransition({ previous, codespace, androidState, setupAvailable, setupFailure, now }: {
  previous: LifecyclePhone; codespace: ProviderObservation; androidState: string;
  setupAvailable: boolean; setupFailure?: string; now: number;
}) {
  const mapped = phoneState(codespace.state);
  const needsSetup = setupAvailable && androidState === "idle";
  const state = codespace.state === "Available" && previous.state === "running" && !needsSetup ? "running"
    : previous.state === "stopping" && ["booting", "stopping"].includes(mapped) ? "stopping" : mapped;
  const started = ["Available", "Starting"].includes(codespace.state);
  const lastStarted = started && ["stopped", "error"].includes(previous.state) ? new Date(now).toISOString() : previous.last_started_at;
  const lastStopped = state === "stopped" && previous.state !== "stopped" ? new Date(now).toISOString() : previous.last_stopped_at;
  const retention = state === "stopped" ? retentionExpiry({ ...previous, last_stopped_at: lastStopped,
    retention_at: codespace.retention_expires_at ?? (previous.state === "stopped" ? previous.retention_at : null) }) : null;
  const detail = state === "running" ? null : codespace.state === "Available"
    ? (setupFailure ?? (setupAvailable ? "Installing Android and starting the runner. The first setup takes several minutes."
      : "Codespace available. Phone setup is not connected yet."))
    : state === "error" ? `GitHub reports ${codespace.state}. Check the codespace on GitHub.` : null;
  return { state, detail, lastStarted, lastStopped, retention };
}

/** Decide usage intervals without reading storage or consulting the system clock.
 * A core-count change closes the current interval and starts its replacement.
 */
export function decideRunChanges({ previous, codespace, state, source, open, now }: {
  previous: Pick<LifecyclePhone, "state" | "last_started_at" | "last_stopped_at"> & {
    cores: number | null; machine: string; idle_timeout_min: number;
  };
  codespace: ProviderObservation; state: string; source: string;
  open?: { id: number; cores: number; started_at: string }; now: number;
}) {
  let close: { id: number; stoppedAt: string } | undefined;
  let create: { cores: number; startedAt: string } | undefined;
  const active = ["Available", "Starting", "Creating", "Provisioning", "Rebuilding"].includes(codespace.state);
  const cores = codespace.machine?.cpus ?? previous.cores ?? (previous.machine === "basicLinux32gb" ? 2 : 4);
  if (open && (state === "stopped" || state === "deleted" || (active && open.cores !== cores))) {
    // last_used_at is activity, not a stop timestamp. Add the chosen idle window.
    const idleEnd = Date.parse(codespace.last_used_at ?? "") + previous.idle_timeout_min * 60_000;
    const end = state === "stopped" && source === "reconciled" && previous.state !== "stopping" && Number.isFinite(idleEnd)
      ? Math.max(Date.parse(open.started_at), Math.min(now, idleEnd)) : now;
    close = { id: open.id, stoppedAt: new Date(end).toISOString() };
  }
  if (active && (!open || open.cores !== cores)) {
    const lastUsed = Date.parse(codespace.last_used_at ?? "");
    const knownStart = ["running", "booting"].includes(previous.state) ? Date.parse(previous.last_started_at ?? "") : lastUsed;
    const started = !open && source === "reconciled" && Number.isFinite(knownStart)
      ? Math.max(Date.parse(previous.last_stopped_at ?? "") || 0, Math.min(now, knownStart)) : now;
    create = { cores, startedAt: new Date(started).toISOString() };
  }
  return { close, create };
}

function phoneState(state: string) {
  if (state === "Shutdown") return "stopped";
  if (state === "Deleted") return "deleted";
  if (state === "ShuttingDown") return "stopping";
  if (["Available", "Starting", "Creating", "Provisioning", "Rebuilding", "Queued", "Awaiting"].includes(state)) return "booting";
  return "error";
}
