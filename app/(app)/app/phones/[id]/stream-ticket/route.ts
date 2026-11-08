import { getUser } from "../../../../../../lib/auth";
import { getSession } from "../../../../../../lib/session";
import { findPhone } from "../../../../../../lib/phones";
import { runnerStream } from "../../../../../../lib/phone-runner";
import { createPhoneStreamApi } from "../../../../../../lib/phone-stream-api";

const stream = createPhoneStreamApi({ user: async () => {
  const user = await getUser(), session = await getSession();
  return user && session ? { id: user.id, sessionId: session.id } : null;
}, phone: findPhone, open: runnerStream });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return stream(request, (await context.params).id);
}
