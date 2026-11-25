import { webhookApi } from "../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

async function handlePOST(request: Request, context: { params: Promise<{ id: string }> }) {
  return webhookApi()(request, (await context.params).id, "test");
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
