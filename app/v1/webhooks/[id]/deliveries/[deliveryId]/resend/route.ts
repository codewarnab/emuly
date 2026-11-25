import { webhookApi } from "../../../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

async function handlePOST(request: Request, context: { params: Promise<{ id: string; deliveryId: string }> }) {
  const { id, deliveryId } = await context.params;
  return webhookApi()(request, id, "deliveries", deliveryId);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
