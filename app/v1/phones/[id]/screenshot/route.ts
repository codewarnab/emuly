import { agentPhoneApi } from "../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

type Context = { params: Promise<{ id: string }> };

/**
 * The phone screen as a PNG for agents. ?scale=0.5 returns a smaller image (fewer tokens) for
 * the agent's own checks. See content/skills/emuly-playbook/references/tasks/screenshots.md.
 */
async function handleGET(request: Request, context: Context) {
  const { id } = await context.params;
  return agentPhoneApi().screenshot(request, id);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
