import { agentPhoneApi } from "../../../../../lib/api";

type Context = { params: Promise<{ id: string }> };

/**
 * The agent asks for its phone's agent-device proxy: public URL, the proxy's own token and
 * a session name. The token is relayed in the body and never logged. A phone that is not
 * running and ready (or a runner without the route) is simply "not available".
 */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return agentPhoneApi().agentDevice(request, id);
}
