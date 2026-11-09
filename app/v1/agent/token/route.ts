import { asyncDb } from "../../../../lib/data/async-db";
import { AgentInputError, exchangeSetupCode } from "../../../../lib/data/agents";
import { agentKeyCommands, allowAgentExchange } from "../../../../lib/auth/agent";

/** Exchanges a one-time setup code for a 90-day agent key. No cookie is needed. */
export async function POST(request: Request) {
  const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
    Response.json(body, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "invalid_input" }, 415);
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip") || "unknown";
  if (!allowAgentExchange(ip)) {
    return json({ error: "rate_limited", message: "Too many setup attempts. Wait a minute and try again." }, 429,
      { "Retry-After": "60" });
  }
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_input" }, 400);
    const input = body as Record<string, unknown>;
    const result = await exchangeSetupCode(asyncDb(), input.code, input.name);
    if (!result) {
      return json({ error: "invalid_code",
        message: "This setup code is invalid, already used, or expired. Click Copy prompt in the Emuly console for a new one." }, 401);
    }
    return json({ key: result.key, expires_at: result.expiresAt, ...agentKeyCommands(result.key) });
  } catch (error) {
    if (error instanceof AgentInputError || error instanceof SyntaxError) {
      return json({ error: "invalid_input", message: error.message }, 400);
    }
    return json({ error: "request_failed", message: "The setup code could not be exchanged. Try again." }, 500);
  }
}
