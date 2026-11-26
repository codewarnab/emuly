import { issueSharedStreamTicket } from "../../../../../../lib/phone/shared-stream-ticket";
import { getSession } from "../../../../../../lib/auth/session";
import { findPhone } from "../../../../../../lib/phone/phones";
import { runnerStream } from "../../../../../../lib/phone/phone-runner";
import { createPhoneStreamApi } from "../../../../../../lib/phone/phone-stream-api";
import { asyncDb } from "../../../../../../lib/data/async-db";
import { phoneObservations } from "../../../../../../lib/phone/phone-observation";
import { directStream } from "../../../../../../lib/phone/direct-stream";

// The video is for the signed-in browser, so one session read gives both the user and the session.
// readSession already refuses a blocked user or an expired session.
const stream = createPhoneStreamApi({ user: async () => {
  const session = await getSession();
  return session ? { id: session.userId, sessionId: session.id } : null;
},phone: findPhone, open: runnerStream, issue: ticket => issueSharedStreamTicket(asyncDb(), ticket), direct: input => directStream(input), observation: (userId, id) => phoneObservations(asyncDb()).issue({ userId, id }) });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return stream(request, (await context.params).id);
}
