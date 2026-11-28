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
  const denied = forbidAgent(user, "Setup codes are for the browser. You already have a key: use it. To check it, GET /v1/me.", "/app");
  if (denied) return denied;
  if (crossOrigin(request, user.authKind)) {
    return json({ error: "forbidden", message: "This request is not allowed from this origin." }, 403);
  }
  const { code, expiresAt } = await createSetupCode(asyncDb(), user.id);
  return json({ code, expires_at: expiresAt, prompt: buildAgentPrompt(env.baseUrl, code) });
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
