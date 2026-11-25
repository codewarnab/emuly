import { linksApi } from "../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

type Context = { params: Promise<{ id: string }> };

/** The phone's traffic path: direct, or through the laptop (`emuly proxy`). */
async function handleGET(request: Request, context: Context) {
  return linksApi().proxyStatus(request, (await context.params).id);
}
async function handlePOST(request: Request, context: Context) {
  return linksApi().proxySet(request, (await context.params).id);
}
async function handleDELETE(request: Request, context: Context) {
  return linksApi().proxyOff(request, (await context.params).id);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
export const POST = withApiUsage(handlePOST);
export const DELETE = withApiUsage(handleDELETE);
