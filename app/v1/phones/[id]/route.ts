import { getUser } from "../../../../lib/auth/auth";
import { AGENT_DELETE_PHONE_MESSAGE } from "../../../../lib/auth/scope";
import { phoneControl } from "../../../../lib/phone/phone-control";
import { GitHubError } from "../../../../lib/github/github";
import { PhoneInputError, redact } from "../../../../lib/phone/phone-mutations";
import { RateLimitError } from "../../../../lib/data/rate-limit";

type Context = { params: Promise<{ id: string }> };

/** Deleting is a browser-console action. An agent key gets a clear 403 instead. */
export async function DELETE(request: Request, context: Context) {
  const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
    Response.json(body, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
  const user = await getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  if (user.authKind === "agent") return json({ error: "forbidden", message: AGENT_DELETE_PHONE_MESSAGE }, 403);
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    return json({ error: "forbidden" }, 403);
  }
  const { id } = await context.params;
  try {
    await phoneControl().remove(user.id, id);
    return json({ deleted: true });
  } catch (error) {
    if (error instanceof GitHubError) return json({ error: "github_refused", message: redact(error.message) }, 409);
    if (error instanceof RateLimitError) return json({ error: "rate_limited", message: error.message }, 429, { "Retry-After": String(error.retryAfter) });
    if (error instanceof PhoneInputError) return json({ error: "invalid_input", message: error.message }, 400);
    return json({ error: "request_failed", message: "The phone could not be deleted. Try again." }, 502);
  }
}
