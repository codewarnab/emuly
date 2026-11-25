import { linksApi } from "../../../../../lib/api";

type Context = { params: Promise<{ id: string }> };

/** The phone's traffic path: direct, or through the laptop (`emuly proxy`). */
export async function GET(request: Request, context: Context) {
  return linksApi().proxyStatus(request, (await context.params).id);
}
export async function POST(request: Request, context: Context) {
  return linksApi().proxySet(request, (await context.params).id);
}
export async function DELETE(request: Request, context: Context) {
  return linksApi().proxyOff(request, (await context.params).id);
}
