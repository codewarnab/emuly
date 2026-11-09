import type { Client } from "@libsql/client";
import { SettingsInputError, chosenPlan, updateSettings, userSettings } from "./settings.ts";
import { listAgentKeys } from "./agents.ts";
import { streamQuality } from "../shared/display-settings.ts";
import { AGENT_SETTINGS_MESSAGE, forbidAgent, manageUrl } from "../auth/scope.ts";

export function createSettingsApi({ database, user }: {
  database: Client; user: () => Promise<{ id: number; authKind?: "session" | "agent" } | null>;
}) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
  return {
    /** Read-only view of every Settings page. It never includes a secret or a key value. */
    async get() {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      try {
        const [settings, override, quality, keys] = await Promise.all([
          userSettings(database, identity.id),
          database.execute({ sql: "SELECT allowance_override FROM billing_settings WHERE user_id = ?", args: [identity.id] }),
          streamQuality(database, identity.id),
          listAgentKeys(database, identity.id),
        ]);
        const plan = override.rows[0]?.allowance_override != null ? "custom" : (await chosenPlan(database, identity.id)) ?? "free";
        return json({
          settings: { ...settings, plan, stream_quality: quality },
          agents: keys.map(key => ({ id: key.id, name: key.name, created_at: key.created_at, last_used_at: key.last_used_at,
            expires_at: key.expires_at, revoked_at: key.revoked_at })),
          manage_url: manageUrl("/app/settings/hours"),
        });
      } catch {
        return json({ error: "request_failed", message: "Settings could not be loaded. Try again." }, 502);
      }
    },
    async patch(request: Request) {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      const denied = forbidAgent(identity, AGENT_SETTINGS_MESSAGE, "/app/settings/hours");
      if (denied) return denied;
      const origin = request.headers.get("origin");
      if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
        return json({ error: "forbidden" }, 403);
      }
      if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "invalid_input" }, 415);
      try { return json(await updateSettings(database, identity.id, await request.json())); }
      catch (error) {
        if (error instanceof SettingsInputError || error instanceof SyntaxError) {
          return json({ error: "invalid_input", message: error.message }, 400);
        }
        return json({ error: "request_failed", message: "Settings could not be saved. Try again." }, 500);
      }
    },
  };
}
