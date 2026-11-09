import { asyncDb } from "../../../../../lib/data/async-db";
import { pollDeviceCode } from "../../../../../lib/data/agents";
import { agentKeyCommands } from "../../../../../lib/auth/agent";

/** The agent polls this route until the browser approves or denies the device login. */
export async function POST(request: Request) {
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "invalid_input" }, 415);
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_input" }, 400);
    const result = await pollDeviceCode(asyncDb(), (body as Record<string, unknown>).device_code);
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
    if (error instanceof SyntaxError) return json({ error: "invalid_input", message: error.message }, 400);
    return json({ error: "request_failed", message: "The sign-in request could not be checked. Try again." }, 500);
  }
}
