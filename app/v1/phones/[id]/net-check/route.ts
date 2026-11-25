import { linksApi } from "../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

/** Tests target=host:port from inside the emulator and gives the fix. With no target: logcat hints only. */
async function handleGET(request: Request, context: { params: Promise<{ id: string }> }) {
  return linksApi().netCheck(request, (await context.params).id);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
