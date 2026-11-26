import { json } from "../../../../lib/http";
import { allowAgentDeviceStart, clientIp } from "../../../../lib/auth/agent";
import { asyncDb } from "../../../../lib/data/async-db";
import { AgentDeviceLimitError, createDeviceCode } from "../../../../lib/data/agents";
import { env } from "../../../../lib/env";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

/** Starts an RFC 8628 device login. No cookie or key is needed. */
async function handlePOST(request: Request) {
  try {
    if (!await allowAgentDeviceStart(clientIp(request))) {
      return json({ error: "rate_limited", message: "Too many sign-in attempts. Wait a minute and try again." }, 429,
        { "Retry-After": "60" });
    }
    const { deviceCode, userCode, expiresIn, interval } = await createDeviceCode(asyncDb());
    return json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${env.baseUrl}/link`,
      verification_uri_complete: `${env.baseUrl}/link?code=${encodeURIComponent(userCode)}`,
      expires_in: expiresIn,
      interval,
    });
  } catch (error) {
    if (error instanceof AgentDeviceLimitError) {
      return json({ error: "rate_limited", message: "Too many sign-in attempts. Wait a minute and try again." }, 429,
        { "Retry-After": "60" });
    }
    return json({ error: "request_failed", message: "The sign-in request could not be started. Try again." }, 500);
  }
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
