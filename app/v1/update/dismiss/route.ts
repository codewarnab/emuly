import { getUser } from "../../../../lib/auth/auth";
import { crossOrigin } from "../../../../lib/auth/origin";
import { updateCheck } from "../../../../lib/api";

/** The user said no to an update: stay quiet until a newer version ships, in every chat. */
export async function POST(request: Request) {
  const identity = await getUser();
  const headers = { "Cache-Control": "private, no-store" };
  if (!identity) return Response.json({ error: "unauthorized" }, { status: 401, headers });
  if (crossOrigin(request, identity.authKind)) return Response.json({ error: "forbidden" }, { status: 403, headers });
  const dismissed = await updateCheck().dismiss();
  return Response.json({ dismissed }, { headers });
}
