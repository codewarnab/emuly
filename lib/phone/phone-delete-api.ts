import "server-only";
import { crossOrigin } from "../auth/origin.ts";
import { AGENT_DELETE_PHONE_MESSAGE } from "../auth/scope.ts";
import type { DatabaseQueries } from "../data/async-database.ts";
import { createPhoneDeleteRequest, getPhoneDeleteRequest } from "../data/phone-deletions.ts";

type Identity = { id: number; authKind?: "session" | "agent"; agentKeyId?: number };
type PhoneView = { id: string; name: string };
type Removal = { ok: true } | { ok: false; status: number; error: string; message: string; retryAfter?: string };

const noStore = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  Response.json(body, { status, headers: { ...noStore, ...headers } });

/** DELETE /v1/phones/<id>. A session always deletes; an agent key needs the user's switch. */
export function createPhoneDeleteApi({ user, phone, agentCanDelete, remove, record, baseUrl }: {
  user: () => Promise<Identity | null>;
  phone: (userId: number, id: string) => Promise<PhoneView | undefined>;
  agentCanDelete: (userId: number) => Promise<boolean>;
  remove: (userId: number, id: string) => Promise<Removal>;
  record: (userId: number, phoneName: string, agentKeyId?: number) => Promise<unknown>;
  baseUrl: () => string;
}) {
  const settingsUrl = () => `${baseUrl().replace(/\/$/, "")}/app/settings/agents`;
  return async function handle(request: Request, id: string) {
    const identity = await user();
    if (!identity) return json({ error: "unauthorized" }, 401);
    if (crossOrigin(request, identity.authKind)) return json({ error: "forbidden" }, 403);
    if (identity.authKind === "agent" && !(await agentCanDelete(identity.id))) {
      return json({ error: "forbidden", message: AGENT_DELETE_PHONE_MESSAGE, manage_url: settingsUrl() }, 403);
    }
    const stored = await phone(identity.id, id);
    if (!stored) return json({ error: "not_found", message: "Phone not found." }, 404);
    const result = await remove(identity.id, id);
    if (!result.ok) {
      return json({ error: result.error, message: result.message }, result.status,
        result.retryAfter ? { "Retry-After": result.retryAfter } : undefined);
    }
    if (identity.authKind === "agent") {
      try { await record(identity.id, stored.name, identity.agentKeyId); } catch {}
      return json({ deleted: true, settings_url: settingsUrl() });
    }
    return json({ deleted: true });
  };
}

/** POST and GET for the approval flow. Both auth kinds may ask and poll. */
export function createPhoneDeleteRequestsApi({ user, phone, database, baseUrl }: {
  user: () => Promise<Identity | null>;
  phone: (userId: number, id: string) => Promise<PhoneView | undefined>;
  database: DatabaseQueries;
  baseUrl: () => string;
}) {
  const approveUrl = (id: string, token: string) =>
    `${baseUrl().replace(/\/$/, "")}/app/phones/${encodeURIComponent(id)}/delete?request=${encodeURIComponent(token)}`;
  return {
    async create(request: Request, id: string) {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      if (crossOrigin(request, identity.authKind)) return json({ error: "forbidden" }, 403);
      try {
        const stored = await phone(identity.id, id);
        if (!stored) return json({ error: "not_found", message: "Phone not found." }, 404);
        const created = await createPhoneDeleteRequest(database, { userId: identity.id, phoneId: id,
          agentKeyId: identity.authKind === "agent" ? identity.agentKeyId : null });
        return json({ request_id: created.id, approve_url: approveUrl(id, created.token),
          expires_in: created.expiresIn, interval: created.interval });
      } catch {
        return json({ error: "request_failed", message: "The deletion request could not be created. Try again." }, 502);
      }
    },
    async read(_request: Request, id: string, requestId: string) {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      try {
        const request = await getPhoneDeleteRequest(database, identity.id, id, requestId);
        if (!request) return json({ error: "not_found", message: "Deletion request not found." }, 404);
        return json({ request_id: request.id, status: request.status });
      } catch {
        return json({ error: "request_failed", message: "The deletion request could not be loaded." }, 502);
      }
    },
  };
}
