import { linksApi } from "../../../../../lib/api";

/** Tests target=host:port from inside the emulator and gives the fix. With no target: logcat hints only. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return linksApi().netCheck(request, (await context.params).id);
}
