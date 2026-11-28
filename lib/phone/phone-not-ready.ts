/** The phone_not_ready reply that every phone route gives when the phone cannot do the step yet. */

/** The fix shape these replies use. Same as Fix in lib/agent-help.ts. */
type Step = { method: "GET" | "POST"; path: string; then?: Step };

export const phonePath = (id: string) => `/v1/phones/${encodeURIComponent(id)}`;
export const waitReady = (id: string): Step => ({ method: "GET", path: `${phonePath(id)}?wait_for=ready&timeout_s=60` });
export const waitStopped = (id: string): Step => ({ method: "GET", path: `${phonePath(id)}?wait_for=stopped&timeout_s=60` });

type Stored = { state: string; android_state: string };

/**
 * The phone_not_ready reply. The next step depends on the state: a booting phone needs only a wait,
 * and a start sent then is wasted and counts toward the rate limit.
 */
export function phoneNotReady(id: string, stored: Stored): { body: Record<string, unknown>; headers?: Record<string, string> } {
  const base = { error: "phone_not_ready", state: stored.state, android_state: stored.android_state };
  if (stored.state === "deleted") {
    return { body: { ...base, message: "This phone was deleted. Create a new phone.", fix: { method: "POST", path: "/v1/phones" } } };
  }
  if (stored.state === "stopped" || stored.state === "error" || (stored.state === "running" && stored.android_state === "failed")) {
    const start = { method: "POST", path: `${phonePath(id)}/start`, then: waitReady(id) };
    return { body: { ...base, message: "Start the phone to use this.", hint: `The phone is ${stored.state} with Android ${stored.android_state}. Start it, wait until ready, then retry.`, fix: start } };
  }
  if (stored.state === "stopping") {
    return { body: { ...base, message: "The phone is stopping. Start it again when it has stopped.", hint: "Wait until it is stopped, then start it.", retry_after: 10,
      fix: { ...waitStopped(id), then: { method: "POST", path: `${phonePath(id)}/start`, then: waitReady(id) } } },
    headers: { "Retry-After": "10" } };
  }
  // Starting, or running while Android boots: only wait. Do not send another start.
  return { body: { ...base, message: "The phone is starting. Wait until it is ready.",
    hint: `The phone is ${stored.state} with Android ${stored.android_state}. Wait until ready, then retry. Do not start it again.`,
    retry_after: 10, fix: waitReady(id) }, headers: { "Retry-After": "10" } };
}
