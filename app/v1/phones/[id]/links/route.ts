import { linksApi } from "../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

type Context = { params: Promise<{ id: string }> };

/** Links from the phone to a server the laptop can reach. */
async function handleGET(request: Request, context: Context) {
  return linksApi().list(request, (await context.params).id);
}
async function handlePOST(request: Request, context: Context) {
  return linksApi().create(request, (await context.params).id);
}
async function handleDELETE(request: Request, context: Context) {
  return linksApi().remove(request, (await context.params).id);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
export const POST = withApiUsage(handlePOST);
export const DELETE = withApiUsage(handleDELETE);
