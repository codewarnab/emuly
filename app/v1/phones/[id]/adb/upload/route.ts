import { agentPhoneApi } from "../../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

type Context = { params: Promise<{ id: string }> };

/** Step 1 of a large adb upload: a one-time ticket to PUT the file bytes straight to the phone. */
async function handlePOST(request: Request, context: Context) {
  const { id } = await context.params;
  return agentPhoneApi().adbUpload(request, id);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
