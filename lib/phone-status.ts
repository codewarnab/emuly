import type { PillKind } from "../components/pill";

type StatusPhone = {
  state: string;
  state_detail?: string | null;
  android_state?: string;
  keeping?: number;
};

/** The same current status appears on cards, lists, and the phone screen. */
export function phoneStatus(phone: StatusPhone): { kind: PillKind; label: string; title: string; description: string } {
  if (phone.keeping) return { kind: "booting", label: "keeping", title: "Keeping this phone",
    description: "Renewing storage retention. The phone will stop again when this finishes." };
  switch (phone.state) {
    case "stopping": return { kind: "stopping", label: "stopping", title: "Stopping the codespace",
      description: "Waiting for GitHub to finish stopping this phone." };
    case "stopped": return { kind: "stopped", label: "stopped", title: "Phone stopped",
      description: "Wake it to resume the same device." };
    case "pending": return { kind: "booting", label: "creating", title: "Creating the codespace",
      description: "Waiting for GitHub to create this phone." };
    case "booting": {
      if (/^(Phone setup failed|Could not reach the codespace)/.test(phone.state_detail ?? "")) {
        return { kind: "needsyou", label: "setup failed", title: "Setup failed", description: phone.state_detail! };
      }
      return phone.state_detail
        ? { kind: "booting", label: "setting up", title: "Setting up Android", description: phone.state_detail }
        : { kind: "booting", label: "starting", title: "Starting the codespace",
          description: "Waiting for GitHub to start this phone." };
    }
    case "running": {
      if (phone.android_state === "ready") return { kind: "running", label: "running", title: "Live screen", description: "Android is ready." };
      if (phone.android_state === "failed") return { kind: "needsyou", label: "Android failed", title: "Android boot failed",
        description: "The codespace is running, but Android failed to start." };
      return { kind: "booting", label: "starting Android", title: "Starting Android",
        description: "The codespace is running. Waiting for Android to finish starting." };
    }
    default: return { kind: "needsyou", label: "failed", title: "Phone unavailable",
      description: phone.state_detail ?? "The phone status is unavailable." };
  }
}

/** Clarify historical messages without rewriting the stored activity log. */
export function phoneEventMessage(message: string): string {
  if (message === "Phone ready") return "Phone runner ready";
  if (message === "Phone setup started") return "Android setup started";
  const codespaceMessages: Record<string, string> = {
    "Codespace Provisioning": "Codespace creation started",
    "Codespace Creating": "Codespace creation started",
    "Codespace Starting": "Codespace start reported by GitHub",
    "Codespace Available": "Codespace available; Android readiness checked separately",
    "Codespace ShuttingDown": "Codespace stop reported by GitHub",
    "Codespace Shutdown": "Codespace stopped",
  };
  return codespaceMessages[message] ?? message;
}
