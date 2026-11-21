import { agentPhoneApi } from "../../../../../lib/api";

type Context = { params: Promise<{ id: string }> };

/**
 * The screen's UI tree as JSON for agents: text, id, bounds and a tap point for each useful node.
 * ?all=1 returns every node. See content/skills/emuly-playbook/references/screenshots.md.
 */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return agentPhoneApi().ui(request, id);
}
