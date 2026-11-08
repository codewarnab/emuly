import { getUser } from "../../../../../../lib/auth";
import { getSession } from "../../../../../../lib/session";
import { findPhone } from "../../../../../../lib/phone/phones";
import { runnerStream } from "../../../../../../lib/phone/phone-runner";
import { createPhoneStreamApi } from "../../../../../../lib/phone/phone-stream-api";
import { db } from "../../../../../../lib/db";
import { phoneObservations } from "../../../../../../lib/phone/phone-observation";

const stream = createPhoneStreamApi({ user: async () => {
  const user = await getUser(), session = await getSession();
  return user && session ? { id: user.id, sessionId: session.id } : null;
}, phone: findPhone, open: runnerStream, observation: (userId, id) => phoneObservations(db()).issue({ userId, id }) });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return stream(request, (await context.params).id);
}
