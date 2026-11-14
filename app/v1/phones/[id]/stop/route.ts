import { agentPhoneApi } from "../../../../../lib/api";

// A stop may call the runner three times, up to 80 s each.
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return agentPhoneApi().stop(request, id);
}
