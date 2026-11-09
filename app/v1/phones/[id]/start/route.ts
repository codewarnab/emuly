import { agentPhoneApi } from "../../../../../lib/api";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return agentPhoneApi().start(request, id);
}
