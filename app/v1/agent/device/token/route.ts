import { json, readJsonObject } from "../../../../../lib/http";
import { asyncDb } from "../../../../../lib/data/async-db";
import { pollDeviceCode } from "../../../../../lib/data/agents";
import { agentKeyCommands } from "../../../../../lib/auth/agent";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

/** The agent polls this route until the browser approves or denies the device login. */
async function handlePOST(request: Request) {
  const body = await readJsonObject(request);
  if (body.response) return body.response;
  try {
    const result = await pollDeviceCode(asyncDb(), body.value.device_code);
    switch (result.status) {
      case "pending":
        return json({ error: "authorization_pending", message: "The user has not approved this sign-in yet." }, 400);
      case "slow_down":
        return json({ error: "slow_down", message: "Poll less often, then try again." }, 400);
      case "denied":
        return json({ error: "access_denied", message: "The user denied this sign-in." }, 400);
      case "expired":
        return json({ error: "expired_token", message: "This sign-in request expired. Click Copy prompt again for a new link." }, 400);
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
