import { webhookApi } from "../../../../../lib/api";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return webhookApi()(request, (await context.params).id, "deliveries");
}
