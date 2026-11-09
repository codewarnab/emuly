import { getUser } from "../../../../../../lib/auth/auth";
import { asyncDb } from "../../../../../../lib/data/async-db";
import { env } from "../../../../../../lib/env";
import { createPhoneDeleteRequestsApi } from "../../../../../../lib/phone/phone-delete-api";
import { findPhone } from "../../../../../../lib/phone/phones";

type Context = { params: Promise<{ id: string; requestId: string }> };

export async function GET(request: Request, context: Context) {
  const { id, requestId } = await context.params;
  return createPhoneDeleteRequestsApi({ user: getUser, phone: findPhone, database: asyncDb(),
    baseUrl: () => env.baseUrl }).read(request, id, requestId);
}
