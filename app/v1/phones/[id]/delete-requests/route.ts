import { getUser } from "../../../../../lib/auth/auth";
import { asyncDb } from "../../../../../lib/data/async-db";
import { env } from "../../../../../lib/env";
import { createPhoneDeleteRequestsApi } from "../../../../../lib/phone/phone-delete-api";
import { findPhone } from "../../../../../lib/phone/phones";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

type Context = { params: Promise<{ id: string }> };

async function handlePOST(request: Request, context: Context) {
  const { id } = await context.params;
  return createPhoneDeleteRequestsApi({ user: getUser, phone: findPhone, database: asyncDb(),
    baseUrl: () => env.baseUrl }).create(request, id);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
