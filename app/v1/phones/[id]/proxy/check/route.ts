import { linksApi } from "../../../../../../lib/api";

/** Gets the exit IP through the phone's current traffic path. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return linksApi().proxyCheck(request, (await context.params).id);
}
