import { webhookApi } from "../../../../../lib/api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return webhookApi()(request, (await context.params).id, "test");
}
