import { agentPhoneApi } from "../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

// A stop may call the runner three times, up to 80 s each.
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

async function handlePOST(request: Request, context: Context) {
  const { id } = await context.params;
  return agentPhoneApi().stop(request, id);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
