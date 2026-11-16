import { linksApi } from "../../../../../lib/api";

type Context = { params: Promise<{ id: string }> };

/** Links from the phone to a server the laptop can reach. See docs/link-plan.html. */
export async function GET(request: Request, context: Context) {
  return linksApi().list(request, (await context.params).id);
}
export async function POST(request: Request, context: Context) {
  return linksApi().create(request, (await context.params).id);
}
export async function DELETE(request: Request, context: Context) {
  return linksApi().remove(request, (await context.params).id);
}
