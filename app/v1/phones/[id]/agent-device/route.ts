import { agentPhoneApi } from "../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

type Context = { params: Promise<{ id: string }> };

/**
 * The agent asks for its phone's agent-device proxy: public URL, the proxy's own token and
 * a session name. The token is relayed in the body and never logged. A phone that is not
 * running and ready (or a runner without the route) is simply "not available".
 */
async function handleGET(request: Request, context: Context) {
  const { id } = await context.params;
  return agentPhoneApi().agentDevice(request, id);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
