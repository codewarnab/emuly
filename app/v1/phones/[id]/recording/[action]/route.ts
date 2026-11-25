import { agentPhoneApi } from "../../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

type Context = { params: Promise<{ id: string; action: string }> };

/**
 * Screen recording for agents. POST start, test the app, POST stop, then GET file returns the MP4.
 * The runner copies the H.264 stream that viewers already get into the file: no second encoder.
 * GET status, POST discard, POST mark ({text}: a note at this moment of the video) and
 * GET notes (?format=vtt for WebVTT) are also available. See content/skills/emuly-playbook/references/tasks/screenshots.md.
 */
async function handleGET(request: Request, context: Context) {
  const { id, action } = await context.params;
  return agentPhoneApi().recording(request, id, action);
}

async function handlePOST(request: Request, context: Context) {
  const { id, action } = await context.params;
  return agentPhoneApi().recording(request, id, action);
}

// A 30-minute recording can be large; the download streams for up to this long.
export const maxDuration = 300;

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
export const POST = withApiUsage(handlePOST);
