import { webhookApi } from "../../../../../../../lib/api";

export async function POST(request: Request, context: { params: Promise<{ id: string; deliveryId: string }> }) {
  const { id, deliveryId } = await context.params;
  return webhookApi()(request, id, "deliveries", deliveryId);
}
