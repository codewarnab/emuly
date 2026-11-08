import type { Client } from "@libsql/client";
import { SettingsInputError, updateSettings } from "./settings.ts";

export function createSettingsApi({ database, user }: {
  database: Client; user: () => Promise<{ id: number } | null>;
}) {
  return async function patch(request: Request) {
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
    const identity = await user();
    if (!identity) return json({ error: "unauthorized" }, 401);
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
  };
}
