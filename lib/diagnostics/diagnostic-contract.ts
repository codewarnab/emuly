// Shared admission contract. Never accept arbitrary strings, metadata, or exception text.
export const stepCodes = [
  "request_accepted", "github_create", "github_start", "github_stop", "github_delete", "provider_wait",
  "credential_lookup", "metadata_fetch", "tunnel_lookup", "relay_connect", "port_wait", "ssh_server", "ssh_auth", "command",
  "forwarded_probe", "setup_check", "setup_upload", "setup_launch", "kvm", "runtime_libraries", "sdk_tools", "sdk_packages",
  "android_cli", "avd", "scrcpy", "agent_device", "runner_launch", "runner_health", "adb_init", "cli_boot", "fallback_boot", "boot_completed",
  "android_boot", "stream_authorization", "stream_attach", "stream_detach", "first_decoded", "first_painted", "screenshot_fallback",
  "presence", "input_summary", "reconnect", "keep_awake", "awake_timer_start", "awake_timer_stop", "coverage_gap", "coverage_recovered",
  "observer_restart", "stop_intent", "provider_stop", "poll_backoff", "retry_wait", "collector",
] as const;
export type StepCode = typeof stepCodes[number];
export const outcomes = ["running", "succeeded", "failed", "cancelled", "interrupted", "skipped", "unknown"] as const;
export type Outcome = typeof outcomes[number];
export const errorCodes = ["none", "unknown_failure", "timeout", "cancelled", "credential_unavailable", "connection_failed", "command_failed",
  "no_viewers", "already_pending", "connection_aborted", "observer_shutdown", "invalid_progress", "progress_unavailable", "coverage_missing",
  "socket_closed", "decoder_failed", "queue_full", "hidden", "stale", "phone_stopped", "rate_limited", "provider_unavailable"] as const;
export type ErrorCode = typeof errorCodes[number];
export const operationKinds = ["create", "resume", "boot_retry", "stop", "delete", "keep", "viewing_session"] as const;
export type OperationKind = typeof operationKinds[number];
export type Step = {
  stepId: string; parentStepId?: string; producer: "server" | "setup" | "boot" | "runner" | "browser";
  producerRunId: string; sequence: number; code: StepCode; attempt: number; startedAt: string;
  finishedAt?: string; durationMs?: number; outcome: Outcome; errorCode: ErrorCode;
  quality: "exact" | "observed_interval" | "missing";
  httpStatus?: number; retryDelayMs?: number; exitCode?: number;
  route?: "forwarded" | "tunnel"; disposition?: "installed" | "already_present" | "unknown";
  bootMethod?: "confirmed_snapshot" | "confirmed_cold" | "cli_unspecified" | "raw_fallback" | "unknown";
  count?: number; scheduledAt?: string; visible?: boolean; recentInput?: boolean;
  cause?: "application_stop" | "provider_idle_timeout" | "provider_other" | "unknown";
  confidence?: "confirmed" | "suspected" | "unknown";
  initiator?: "owner" | "stop_all" | "hours_budget" | "retention";
  providerState?: "ShuttingDown" | "Shutdown" | "Deleted" | "Failed";
  idleTimeoutMin?: number; evidenceSource?: "configured" | "provider" | "unavailable";
  consecutiveFailures?: number; sinceSuccessMs?: number; providerActivityAt?: string; presenceLeaseMs?: number;
};
const optionalEnums = {
  route: ["forwarded", "tunnel"], disposition: ["installed", "already_present", "unknown"],
  bootMethod: ["confirmed_snapshot", "confirmed_cold", "cli_unspecified", "raw_fallback", "unknown"],
  cause: ["application_stop", "provider_idle_timeout", "provider_other", "unknown"], confidence: ["confirmed", "suspected", "unknown"],
  initiator: ["owner", "stop_all", "hours_budget", "retention"], providerState: ["ShuttingDown", "Shutdown", "Deleted", "Failed"],
  evidenceSource: ["configured", "provider", "unavailable"],
};
const numericBounds = { sequence: [1, 100000], attempt: [1, 10000], durationMs: [0, 86400000], httpStatus: [100, 599],
  retryDelayMs: [0, 86400000], exitCode: [0, 255], count: [0, 100000], idleTimeoutMin: [1, 1440],
  consecutiveFailures: [0, 100000], sinceSuccessMs: [0, 86400000], presenceLeaseMs: [0, 75000] };
const fields = new Set(["stepId", "parentStepId", "producer", "producerRunId", "code", "startedAt", "finishedAt", "scheduledAt", "outcome", "errorCode", "quality",
  "visible", "recentInput", "providerActivityAt", ...Object.keys(optionalEnums), ...Object.keys(numericBounds)]);
export const diagnosticId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const timestamp = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
export function validateStep(value: unknown): Step | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(k => !fields.has(k)) || JSON.stringify(r).length > 2048) return;
  if (![r.stepId, r.producerRunId].every(diagnosticId) || (r.parentStepId !== undefined && !diagnosticId(r.parentStepId))) return;
  if (!["server", "setup", "boot", "runner", "browser"].includes(String(r.producer)) || !stepCodes.includes(r.code as StepCode)
    || !outcomes.includes(r.outcome as Outcome) || !errorCodes.includes(r.errorCode as ErrorCode)
    || !["exact", "observed_interval", "missing"].includes(String(r.quality))) return;
  if (!timestamp(r.startedAt) || !Number.isInteger(r.sequence) || !Number.isInteger(r.attempt)) return;
  for (const key of ["finishedAt", "scheduledAt", "providerActivityAt"]) if (r[key] !== undefined && !timestamp(r[key])) return;
  if (r.finishedAt !== undefined && Date.parse(String(r.finishedAt)) < Date.parse(String(r.startedAt))) return;
  for (const [key, [min, max]] of Object.entries(numericBounds)) {
    if (r[key] !== undefined && (!Number.isSafeInteger(r[key]) || Number(r[key]) < min || Number(r[key]) > max)) return;
  }
  for (const [key, values] of Object.entries(optionalEnums)) if (r[key] !== undefined && !(values as readonly unknown[]).includes(r[key])) return;
  for (const key of ["visible", "recentInput"]) if (r[key] !== undefined && typeof r[key] !== "boolean") return;
  if (r.outcome === "running" && (r.finishedAt !== undefined || r.durationMs !== undefined)) return;
  if (r.outcome !== "running" && r.finishedAt === undefined) return;
  return r as Step;
}
