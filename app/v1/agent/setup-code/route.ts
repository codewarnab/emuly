import { getUser } from "../../../../lib/auth/auth";
import { forbidAgent } from "../../../../lib/auth/scope";
import { asyncDb } from "../../../../lib/data/async-db";
import { createSetupCode } from "../../../../lib/data/agents";
import { buildAgentPrompt } from "../../../../lib/agent-prompt";
import { env } from "../../../../lib/env";

/** A browser session mints the one-time code that the copied prompt carries. Agents cannot mint keys. */
export async function POST(request: Request) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
  const user = await getUser();
  if (!user) return json({ error: "unauthorized", message: "Sign in to copy a setup prompt.", base_url: env.baseUrl }, 401);
  const denied = forbidAgent(user, "Agent keys cannot create setup codes. Click Copy prompt in the Emuly console.");
  if (denied) return denied;
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    return json({ error: "forbidden" }, 403);
  }
  const { code, expiresAt } = await createSetupCode(asyncDb(), user.id);
  return json({ code, expires_at: expiresAt, prompt: buildAgentPrompt(env.baseUrl, code) });
}
