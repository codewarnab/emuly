import { getUser } from "../../../../lib/auth/auth";
import { crossOrigin } from "../../../../lib/auth/origin";
import { updateCheck } from "../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

/** The user said no to an update: stay quiet until a newer version ships, in every chat. */
async function handlePOST(request: Request) {
  const identity = await getUser();
  const headers = { "Cache-Control": "private, no-store" };
  if (!identity) return Response.json({ error: "unauthorized" }, { status: 401, headers });
  if (crossOrigin(request, identity.authKind)) return Response.json({ error: "forbidden" }, { status: 403, headers });
  const dismissed = await updateCheck().dismiss();
  return Response.json({ dismissed }, { headers });
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
