import { getUser } from "../../../../../lib/auth/auth";
import { asyncDb } from "../../../../../lib/data/async-db";
import { env } from "../../../../../lib/env";
import { createPhoneDeleteRequestsApi } from "../../../../../lib/phone/phone-delete-api";
import { findPhone } from "../../../../../lib/phone/phones";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return createPhoneDeleteRequestsApi({ user: getUser, phone: findPhone, database: asyncDb(),
    baseUrl: () => env.baseUrl }).create(request, id);
}
