import { retentionExpiry } from "../data/retention.ts";

/** Snapshot needed to reconcile provider state; contains no persistence handles. */
type LifecyclePhone = {
  state: string; state_detail?: string | null; last_started_at: string | null; last_stopped_at: string | null;
  retention_at: string | null; retention_min: number;
};
type ProviderObservation = {
  state: string; last_used_at?: string; retention_expires_at?: string | null;
  machine?: { cpus: number } | null;
};

/** GitHub codespace states in which the machine runs and uses hours. */
export const ACTIVE_GITHUB_STATES: readonly string[] = ["Available", "Starting", "Creating", "Provisioning", "Rebuilding"];
/** GitHub states that end in a running codespace. Unavailable is a short host problem, not an error. */
const BOOTING_GITHUB_STATES: readonly string[] = [...ACTIVE_GITHUB_STATES, "Queued", "Awaiting", "Unavailable"];

export const PHONE_STATES = ["creating", "booting", "running", "stopping", "stopped", "error", "deleted"] as const;
export type PhoneState = typeof PHONE_STATES[number];
export const PHONE_EVENTS = ["start", "stop", "setup_ready", "setup_gave_up", "stopped", "delete"] as const;
export type PhoneEvent = typeof PHONE_EVENTS[number];
export type Transition = { ok: true; state: PhoneState } | { ok: false; reason: string };

const refuse = (reason: string): Transition => ({ ok: false, reason });
const to = (state: PhoneState): Transition => ({ ok: true, state });
const STILL_STOPPING = "The phone is still stopping. Start it again after it stops.";
const DELETED = "The phone was deleted.";
const NO_CODESPACE = "This phone has no codespace yet. Wait until it is created.";

/**
 * Every allowed change of persisted phone state, in one table. A refusal carries the reason for
 * the user. Provider observations go through `decidePhoneTransition`; this table is for requests
 * and for the results of Emuly's own work.
 */
const TRANSITIONS: Record<PhoneState, Record<PhoneEvent, Transition>> = {
  creating: { start: refuse(NO_CODESPACE), stop: refuse(NO_CODESPACE), setup_ready: refuse(NO_CODESPACE),
    setup_gave_up: to("error"), stopped: to("stopped"), delete: to("deleted") },
  booting: { start: to("booting"), stop: to("stopping"), setup_ready: to("running"), setup_gave_up: to("error"),
    stopped: to("stopped"), delete: to("deleted") },
  running: { start: to("running"), stop: to("stopping"), setup_ready: to("running"), setup_gave_up: refuse("Setup already finished."),
    stopped: to("stopped"), delete: to("deleted") },
  stopping: { start: refuse(STILL_STOPPING), stop: to("stopping"), setup_ready: refuse(STILL_STOPPING),
    setup_gave_up: refuse(STILL_STOPPING), stopped: to("stopped"), delete: to("deleted") },
  stopped: { start: to("booting"), stop: to("stopped"), setup_ready: refuse("The phone is stopped."),
    setup_gave_up: refuse("The phone is stopped."), stopped: to("stopped"), delete: to("deleted") },
  error: { start: to("booting"), stop: to("stopping"), setup_ready: refuse("Start the phone again."),
    setup_gave_up: to("error"), stopped: to("stopped"), delete: to("deleted") },
  deleted: { start: refuse(DELETED), stop: refuse(DELETED), setup_ready: refuse(DELETED), setup_gave_up: refuse(DELETED),
    stopped: refuse(DELETED), delete: to("deleted") },
};

/** The state after `event`, or the reason it is refused. An unknown state is refused. */
export function nextState(current: string, event: PhoneEvent): Transition {
  const row = (TRANSITIONS as Record<string, Record<PhoneEvent, Transition> | undefined>)[current];
  return row ? row[event] : refuse(`Unknown phone state ${current}.`);
}

/** How long after a stop request GitHub may still report a starting codespace. */
export const STOP_GRACE_MS = 180_000;
/** How long after a start request GitHub may still report a stopped codespace. */
export const START_GRACE_MS = 120_000;
/** Set by an Emuly start; only such a start may keep "booting" while GitHub still says Shutdown. */
export const START_PENDING_DETAIL = "GitHub is starting the codespace.";

/** Decide persisted phone state from a provider observation at the supplied time.
 * The service retains responsibility for guards, writes, diagnostics and remote work.
 */
export function decidePhoneTransition({ previous, codespace, androidState, setupAvailable, setupFailure, stopRequestedAt, now }: {
  previous: LifecyclePhone; codespace: ProviderObservation; androidState: string;
  setupAvailable: boolean; setupFailure?: string; stopRequestedAt: number | null; now: number;
}) {
  const mapped = phoneState(codespace.state);
  const needsSetup = setupAvailable && androidState === "idle";
  // After a stop, GitHub can briefly report starting again. Past that window an Available
  // codespace means someone restarted it outside Emuly, so resume the normal setup path.
  const stillStopping = previous.state === "stopping" && (mapped === "stopping"
    || (mapped === "booting" && stopRequestedAt !== null && now - stopRequestedAt < STOP_GRACE_MS));
  // GitHub answers a start before it leaves Shutdown. Keep showing the start until it moves.
  const startPending = previous.state === "booting" && mapped === "stopped" && previous.state_detail === START_PENDING_DETAIL
    && previous.last_started_at !== null
    && now - Date.parse(previous.last_started_at) < START_GRACE_MS;
  const state = codespace.state === "Available" && previous.state === "running" && !needsSetup ? "running"
    : stillStopping ? "stopping" : startPending ? "booting" : mapped;
  const started = ["Available", "Starting"].includes(codespace.state);
  const lastStarted = started && ["stopped", "error"].includes(previous.state) ? new Date(now).toISOString() : previous.last_started_at;
  const lastStopped = state === "stopped" && previous.state !== "stopped" ? new Date(now).toISOString() : previous.last_stopped_at;
  const retention = state === "stopped" ? retentionExpiry({ ...previous, last_stopped_at: lastStopped,
    retention_at: codespace.retention_expires_at ?? (previous.state === "stopped" ? previous.retention_at : null) }) : null;
  const detail = startPending ? START_PENDING_DETAIL : state === "running" ? null : codespace.state === "Available"
    ? (setupFailure ?? (setupAvailable ? "Installing Android and starting the runner. The first setup takes several minutes."
      : "Codespace available. Phone setup is not connected yet."))
    : codespace.state === "Unavailable" ? "GitHub reports the codespace as Unavailable. This is usually short. If it stays for 5 minutes, choose Stop, then Start."
    : state === "error" ? `GitHub reports ${codespace.state}. Check the codespace on GitHub.` : null;
  return { state, detail, lastStarted, lastStopped, retention };
}

/** Decide usage intervals without reading storage or consulting the system clock.
 * A core-count change closes the current interval and starts its replacement.
 */
export function decideRunChanges({ previous, codespace, state, source, open, now }: {
  previous: Pick<LifecyclePhone, "state" | "last_started_at" | "last_stopped_at"> & {
    cores: number | null; machine: string; idle_timeout_min: number; provider_idle_min?: number | null;
  };
  codespace: ProviderObservation; state: string; source: string;
  open?: { id: number; cores: number; started_at: string }; now: number;
}) {
  let close: { id: number; stoppedAt: string } | undefined;
  let create: { cores: number; startedAt: string } | undefined;
  const active = ACTIVE_GITHUB_STATES.includes(codespace.state);
  const cores = codespace.machine?.cpus ?? previous.cores ?? (previous.machine === "basicLinux32gb" ? 2 : 4);
  if (open && (state === "stopped" || state === "deleted" || (active && open.cores !== cores))) {
    // last_used_at is activity, not a stop timestamp. Add the idle window that GitHub got.
    const idleEnd = Date.parse(codespace.last_used_at ?? "") + (previous.provider_idle_min ?? previous.idle_timeout_min) * 60_000;
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
  // GitHub's API can report ShuttingDown for many minutes after its web page already shows
  // the codespace as stopped, while it saves the disk. Trust the API: stay "stopping" until
  // it reports Shutdown. A long "stopping" is not a poller fault.
  if (state === "ShuttingDown") return "stopping";
  // Unavailable is GitHub's short host problem while it creates or resumes a codespace. It
  // clears on its own or after a new start request, so it is not a phone error.
  if (BOOTING_GITHUB_STATES.includes(state)) return "booting";
  return "error";
}
