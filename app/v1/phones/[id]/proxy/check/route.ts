import { linksApi } from "../../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

/** Gets the exit IP through the phone's current traffic path. */
async function handlePOST(request: Request, context: { params: Promise<{ id: string }> }) {
  return linksApi().proxyCheck(request, (await context.params).id);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
