import { webhookApi } from "../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

type Context = { params: Promise<{ id: string }> };
async function handleGET(request: Request, context: Context) { return webhookApi()(request, (await context.params).id); }
async function handlePATCH(request: Request, context: Context) { return webhookApi()(request, (await context.params).id); }
async function handleDELETE(request: Request, context: Context) { return webhookApi()(request, (await context.params).id); }

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
export const PATCH = withApiUsage(handlePATCH);
export const DELETE = withApiUsage(handleDELETE);
