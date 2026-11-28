import { json, readJsonObject } from "../../../../../lib/http";
import { asyncDb } from "../../../../../lib/data/async-db";
import { DEVICE_POLL_INTERVAL_MS, pollDeviceCode } from "../../../../../lib/data/agents";
import { agentKeyCommands } from "../../../../../lib/auth/agent";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

const POLL_S = DEVICE_POLL_INTERVAL_MS / 1000;

/** The agent polls this route until the browser approves or denies the device login. */
async function handlePOST(request: Request) {
  const body = await readJsonObject(request);
  if (body.response) return body.response;
  try {
    const result = await pollDeviceCode(asyncDb(), body.value.device_code);
    switch (result.status) {
      case "pending":
        return json({ error: "authorization_pending", message: "Waiting for the user to approve. Poll again after interval seconds.",
          interval: POLL_S, retry_after: POLL_S }, 400);
      case "slow_down":
        return json({ error: "slow_down", message: "Poll less often: wait interval seconds between polls.", interval: POLL_S, retry_after: POLL_S }, 400);
      case "denied":
        return json({ error: "access_denied", message: "The user denied this sign-in. Do not retry unless the user asks.", needs_user: true }, 400);
      case "expired":
        return json({ error: "expired_token", message: "This sign-in expired. Start a new one and show the user the new link.",
          fix: { method: "POST", path: "/v1/agent/device" } }, 400);
      case "approved":
        return json({ key: result.key, expires_at: result.expiresAt, ...agentKeyCommands(result.key) });
      default:
        return json({ error: "invalid_grant", message: "This sign-in request is invalid or was already used." }, 400);
    }
  } catch (error) {
    return json({ error: "request_failed", message: "The sign-in request could not be checked. Try again." }, 500);
  }
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
