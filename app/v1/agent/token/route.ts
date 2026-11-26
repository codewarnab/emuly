import { json, readJsonObject } from "../../../../lib/http";
import { asyncDb } from "../../../../lib/data/async-db";
import { AgentInputError, exchangeSetupCode } from "../../../../lib/data/agents";
import { agentKeyCommands, allowAgentExchange, clientIp } from "../../../../lib/auth/agent";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

/** Exchanges a one-time setup code for a 90-day agent key. No cookie is needed. */
async function handlePOST(request: Request) {
  try {
    if (!await allowAgentExchange(clientIp(request))) {
      return json({ error: "rate_limited", message: "Too many setup attempts. Wait a minute and try again." }, 429,
        { "Retry-After": "60" });
    }
    const body = await readJsonObject(request);
    if (body.response) return body.response;
    const input = body.value;
    const result = await exchangeSetupCode(asyncDb(), input.code, input.name);
    if (!result) {
      return json({ error: "invalid_code",
        message: "This setup code is invalid, already used, or expired. Click Copy prompt in the Emuly console for a new one." }, 401);
    }
    return json({ key: result.key, expires_at: result.expiresAt, ...agentKeyCommands(result.key) });
  } catch (error) {
    if (error instanceof AgentInputError) {
      return json({ error: "invalid_input", message: error.message }, 400);
    }
    return json({ error: "request_failed", message: "The setup code could not be exchanged. Try again." }, 500);
  }
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
