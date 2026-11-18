import { agentPhoneApi } from "../../../../../../lib/api";

type Context = { params: Promise<{ id: string; action: string }> };

/**
 * Screen recording for agents. POST start, test the app, POST stop, then GET file returns the MP4.
 * The runner copies the H.264 stream that viewers already get into the file: no second encoder.
 * GET status and POST discard are also available. See content/skills/emuly-playbook/references/screenshots.md.
 */
export async function GET(request: Request, context: Context) {
  const { id, action } = await context.params;
  return agentPhoneApi().recording(request, id, action);
}

export async function POST(request: Request, context: Context) {
  const { id, action } = await context.params;
  return agentPhoneApi().recording(request, id, action);
}

// A 30-minute recording can be large; the download streams for up to this long.
export const maxDuration = 300;
