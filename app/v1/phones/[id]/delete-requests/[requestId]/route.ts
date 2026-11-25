import { getUser } from "../../../../../../lib/auth/auth";
import { asyncDb } from "../../../../../../lib/data/async-db";
import { env } from "../../../../../../lib/env";
import { createPhoneDeleteRequestsApi } from "../../../../../../lib/phone/phone-delete-api";
import { findPhone } from "../../../../../../lib/phone/phones";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

export const maxDuration = 60;

type Context = { params: Promise<{ id: string; requestId: string }> };

async function handleGET(request: Request, context: Context) {
  const { id, requestId } = await context.params;
  return createPhoneDeleteRequestsApi({ user: getUser, phone: findPhone, database: asyncDb(),
    baseUrl: () => env.baseUrl }).read(request, id, requestId);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
