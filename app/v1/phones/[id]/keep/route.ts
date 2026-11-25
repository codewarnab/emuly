import { phoneApi } from "../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

async function handlePOST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return phoneApi().keep(request, id);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
