import type { createPhoneService } from "./phone-mutations.ts";
import { PhoneInputError, redact } from "./phone-mutations.ts";
import { GitHubError, PHONE_MACHINE } from "../github/github.ts";
import { IDLE_MAX, IDLE_MIN, validIdle } from "../shared/idle.ts";
import { RateLimitError } from "../data/rate-limit.ts";
import type { Usage } from "../data/usage.ts";

/** HTTP boundary shared by route handlers. Identity always comes from the session. */
export function createPhoneApi({ user, service, template, usage, defaults }: {
  user: () => Promise<{ id: number } | null>;
  service: Pick<ReturnType<typeof createPhoneService>, "create" | "keep">;
  template: () => { repository: string; repositoryId: number; devcontainerPath?: string };
  usage: (userId: number) => Usage | Promise<Usage>;
  defaults: (userId: number) => { default_machine: string | null; default_idle_min: number } | Promise<{ default_machine: string | null; default_idle_min: number }>;
}) {
  const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
    Response.json(body, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
  return {
    async keep(request: Request, id: string) {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      const origin = request.headers.get("origin");
      if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
        return json({ error: "forbidden" }, 403);
      }
      try {
        await service.keep(identity.id, id);
        return json({ id, status: "keeping" }, 202);
      } catch (error) {
        if (error instanceof GitHubError) return json({ error: "github_refused", message: redact(error.message) }, 409);
        if (error instanceof RateLimitError) return json({ error: "rate_limited", message: error.message }, 429, { "Retry-After": String(error.retryAfter) });
        if (error instanceof PhoneInputError) return json({ error: "invalid_input", message: error.message }, 400);
        return json({ error: "request_failed", message: "Keep it could not be confirmed. Refresh to check progress." }, 502);
      }
    },
    async usage() {
      const identity = await user();
      return identity ? json(await usage(identity.id)) : json({ error: "unauthorized" }, 401);
    },
    async create(request: Request) {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      const origin = request.headers.get("origin");
      if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
        return json({ error: "forbidden" }, 403);
      }
      if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "invalid_input" }, 415);
      try {
        const input: unknown = await request.json();
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new PhoneInputError("Expected a JSON object");
        const body = input as Record<string, unknown>;
        const settings = await defaults(identity.id);
        // Every phone uses the 4-core machine; see PHONE_MACHINE.
        const machine = PHONE_MACHINE.name;
        const idle = body.idle_timeout_min ?? settings.default_idle_min;
        if (!validIdle(idle)) {
          throw new PhoneInputError(`Choose an idle timeout from ${IDLE_MIN} to ${IDLE_MAX} minutes.`);
        }
        const id = await service.create(identity.id, { ...template(), machine, idleTimeoutMin: idle });
        return json({ id }, 201);
      } catch (error) {
        if (error instanceof GitHubError) return json({ error: "github_refused", message: redact(error.message) }, 409);
        if (error instanceof RateLimitError) return json({ error: "rate_limited", message: error.message }, 429, { "Retry-After": String(error.retryAfter) });
        if (error instanceof PhoneInputError || error instanceof SyntaxError) return json({ error: "invalid_input", message: error.message }, 400);
        return json({ error: "request_failed", message: "The request could not be confirmed. Check GitHub before trying again." }, 502);
      }
    },
  };
}
