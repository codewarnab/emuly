import { getUser } from "../../../../lib/auth/auth";
import { agentPhoneApi } from "../../../../lib/api";
import { asyncDb } from "../../../../lib/data/async-db";
import { recordAgentPhoneDeletion } from "../../../../lib/data/phone-deletions";
import { userSettings } from "../../../../lib/data/settings";
import { env } from "../../../../lib/env";
import { removePhone } from "../../../../lib/phone/delete-phone";
import { createPhoneDeleteApi } from "../../../../lib/phone/phone-delete-api";
import { findPhone } from "../../../../lib/phone/phones";

type Context = { params: Promise<{ id: string }> };

/** Read one phone. Agent keys and browser sessions are both allowed. */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return agentPhoneApi().read(request, id);
}

/** A session deletes directly. An agent key needs the user's delete switch. */
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return createPhoneDeleteApi({
    user: getUser,
    phone: findPhone,
    agentCanDelete: async userId => (await userSettings(asyncDb(), userId)).agent_delete_phones,
    remove: removePhone,
    record: (userId, phoneName, agentKeyId) => recordAgentPhoneDeletion(asyncDb(), { userId, phoneName, agentKeyId }),
    baseUrl: () => env.baseUrl,
  })(request, id);
}
