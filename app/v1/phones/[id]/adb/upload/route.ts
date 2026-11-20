import { agentPhoneApi } from "../../../../../../lib/api";

type Context = { params: Promise<{ id: string }> };

/** Step 1 of a large adb upload: a one-time ticket to PUT the file bytes straight to the phone. */
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return agentPhoneApi().adbUpload(request, id);
}
