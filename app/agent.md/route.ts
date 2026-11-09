import { buildDevicePrompt } from "../../lib/agent-prompt";
import { env } from "../../lib/env";

/** Old prompts linked here. It now returns the same text a signed-out Copy prompt gives. */
export function GET() {
  return new Response(buildDevicePrompt(env.baseUrl), { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
