import { json } from "../../../../lib/http";
import { crossOrigin } from "../../../../lib/auth/origin";
import { getUser } from "../../../../lib/auth/auth";
import { forbidAgent } from "../../../../lib/auth/scope";
import { asyncDb } from "../../../../lib/data/async-db";
import { createSetupCode } from "../../../../lib/data/agents";
import { buildAgentPrompt, buildDevicePrompt } from "../../../../lib/agent-prompt";
import { env } from "../../../../lib/env";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

/** A browser session mints the one-time code that the copied prompt carries. Agents cannot mint keys. */
async function handlePOST(request: Request) {
  const user = await getUser();
  if (!user) return json({ error: "unauthorized", message: "Sign in to copy a setup prompt.", base_url: env.baseUrl, prompt: buildDevicePrompt(env.baseUrl) }, 401);
  const denied = forbidAgent(user, "Agent keys cannot create setup codes. Open manage_url to do this yourself.", "/app");
  if (denied) return denied;
  if (crossOrigin(request, user.authKind)) {
    return json({ error: "forbidden" }, 403);
  }
  const { code, expiresAt } = await createSetupCode(asyncDb(), user.id);
  return json({ code, expires_at: expiresAt, prompt: buildAgentPrompt(env.baseUrl, code) });
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
