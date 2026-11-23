import { agentPhoneApi } from "../../../../../lib/api";

type Context = { params: Promise<{ id: string }> };

/**
 * The phone screen as a PNG for agents. ?scale=0.5 returns a smaller image (fewer tokens) for
 * the agent's own checks. See content/skills/emuly-playbook/references/tasks/screenshots.md.
 */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return agentPhoneApi().screenshot(request, id);
}
