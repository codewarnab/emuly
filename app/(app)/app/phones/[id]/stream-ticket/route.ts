import { getUser } from "../../../../../../lib/auth/auth";
import { getSession } from "../../../../../../lib/auth/session";
import { findPhone } from "../../../../../../lib/phone/phones";
import { runnerStream } from "../../../../../../lib/phone/phone-runner";
import { createPhoneStreamApi } from "../../../../../../lib/phone/phone-stream-api";
import { asyncDb } from "../../../../../../lib/data/async-db";
import { phoneObservations } from "../../../../../../lib/phone/phone-observation";

const stream = createPhoneStreamApi({ user: async () => {
  const user = await getUser(), session = await getSession();
  return user && session ? { id: user.id, sessionId: session.id } : null;
}, phone: findPhone, open: runnerStream, observation: (userId, id) => phoneObservations(asyncDb()).issue({ userId, id }) });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return stream(request, (await context.params).id);
}
