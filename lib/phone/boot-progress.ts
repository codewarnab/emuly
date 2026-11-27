/** The boot stage an agent sees in GET /v1/phones/:id. It reads only stored columns: no extra network trip. */
export type BootStage = "codespace_creating" | "codespace_starting" | "android_setup" | "emulator_booting"
  | "ready" | "failed" | "stopping" | "stopped";

export type BootProgress = {
  stage: BootStage;
  /** Seconds since this start began. Null when the phone is not starting. */
  elapsed_s: number | null;
  /** When Android last became ready. Null until then, and while a new boot runs. */
  ready_at: string | null;
  /** The current setup step, for example "Booting Android". Only in android_setup. */
  step?: string;
  note?: string;
  hint?: string;
};

type BootPhone = {
  id: string;
  state: string;
  android_state: string;
  state_detail?: string | null;
  setup_failed?: number;
  created_at?: string;
  last_started_at?: string | null;
  android_ready_at?: string | null;
};

/** After this time a start is slow. A cold start (new codespace, no snapshot) often takes this long. */
export const SLOW_BOOT_S = 5 * 60;
/** After this time a start is very slow. The agent can check the events or restart. */
export const STUCK_BOOT_S = 15 * 60;

function stageOf(phone: BootPhone): BootStage {
  switch (phone.state) {
    case "pending": return "codespace_creating";
    case "booting": return phone.setup_failed ? "failed" : phone.state_detail ? "android_setup" : "codespace_starting";
    case "running":
      if (phone.android_state === "ready") return "ready";
      if (phone.android_state === "failed") return "failed";
      if (phone.android_state === "stopping") return "stopping";
      return "emulator_booting";
    case "stopping": return "stopping";
    case "stopped": return "stopped";
    default: return "failed";
  }
}

const STARTING = new Set<BootStage>(["codespace_creating", "codespace_starting", "android_setup", "emulator_booting"]);

export function bootProgress(phone: BootPhone, now: number): BootProgress {
  const stage = stageOf(phone);
  const ready_at = stage === "ready" ? phone.android_ready_at ?? null : null;
  if (!STARTING.has(stage)) return { stage, elapsed_s: null, ready_at };
  const step = stage === "android_setup" && phone.state_detail ? { step: phone.state_detail } : {};
  const since = Date.parse((stage === "codespace_creating" ? phone.created_at : phone.last_started_at ?? phone.created_at) ?? "");
  const elapsed_s = Number.isFinite(since) ? Math.max(0, Math.round((now - since) / 1000)) : null;
  if (elapsed_s === null || elapsed_s < SLOW_BOOT_S) return { stage, elapsed_s, ready_at, ...step };
  const minutes = Math.floor(elapsed_s / 60);
  if (elapsed_s < STUCK_BOOT_S) {
    return { stage, elapsed_s, ready_at, ...step, note: `Still starting after ${minutes} min. This is normal for a cold start.`,
      hint: "Keep waiting with wait_for=ready. The user can see each boot step at browser_url." };
  }
  return { stage, elapsed_s, ready_at, ...step, note: `Still starting after ${minutes} min. This is longer than normal.`,
    hint: "If stage did not change for 5 min, POST stop, wait_for=stopped, then POST start. Tell the user if it fails again." };
}
