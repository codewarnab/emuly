import { agentPhoneApi } from "../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

type Context = { params: Promise<{ id: string }> };

/**
 * The screen's UI tree as JSON for agents: text, id, bounds and a tap point for each useful node.
 * ?all=1 returns every node. See content/skills/emuly-playbook/references/tasks/screenshots.md.
 */
async function handleGET(request: Request, context: Context) {
  const { id } = await context.params;
  return agentPhoneApi().ui(request, id);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
