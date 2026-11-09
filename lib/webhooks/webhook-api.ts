import type { createWebhookService } from "./webhooks.ts";
import { WebhookInputError } from "./webhook-security.ts";
import { WebhookRateLimitError } from "./webhooks.ts";
import { AGENT_WEBHOOK_MESSAGE } from "../auth/scope.ts";

/** Session- or agent-authenticated API. Mutations reject browser cross-origin requests. */
export function createWebhookApi({ user, service }: {
  user: () => Promise<{ id: number; authKind?: "session" | "agent" } | null>; service: ReturnType<typeof createWebhookService>;
}) {
  return async function handle(request: Request, id?: string, resource?: "test" | "deliveries", deliveryId?: string) {
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
    const identity = await user();
    if (!identity) return json({ error: "unauthorized" }, 401);
    const method = request.method;
    // An agent may register a notification target and read the list, but must not alter or remove it.
    if (identity.authKind === "agent" && !((method === "GET" && !id) || (method === "POST" && !id))) {
      return json({ error: "forbidden", message: AGENT_WEBHOOK_MESSAGE }, 403);
    }
    if (method !== "GET") {
      const origin = request.headers.get("origin");
      if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
        return json({ error: "forbidden" }, 403);
      }
    }
    try {
      if (method === "GET" && !id) return json(await service.list(identity.id));
      if (method === "GET" && id && resource === "deliveries") return json(await service.deliveries(identity.id, id));
      if (method === "DELETE" && id && !resource) return json(await service.remove(identity.id, id));
      if (method === "POST" && id && resource === "test") {
        return new URL(request.url).searchParams.get("wait") === "1"
          ? json(await service.testNow(identity.id, id)) : json(await service.test(identity.id, id), 202);
      }
      if (method === "POST" && id && resource === "deliveries" && deliveryId) return json(await service.resend(identity.id, id, deliveryId), 202);
      if ((method === "POST" && !id) || (method === "PATCH" && id && !resource)) {
        if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "invalid_input" }, 415);
        const body: unknown = await request.json();
        return method === "POST" ? json(await service.create(identity.id, body), 201) : json(await service.update(identity.id, id!, body));
      }
      return json({ error: "method_not_allowed" }, 405);
    } catch (error) {
      if (error instanceof WebhookRateLimitError) return json({ error: "rate_limited", message: error.message }, 429);
      if (error instanceof WebhookInputError || error instanceof SyntaxError) return json({ error: "invalid_input", message: error.message }, 400);
      return json({ error: "request_failed", message: "The webhook request failed. Try again." }, 500);
    }
  };
}
