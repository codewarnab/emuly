import { buildDevicePrompt } from "../../lib/agent-prompt";
import { env } from "../../lib/env";
import { connection } from "next/server";
import { SELF_HOST } from "../../lib/selfhost";

/** Old prompts linked here. It now returns the same text a signed-out Copy prompt gives. */
export async function GET() {
  // A self-host image prerenders this route at build time, so a runtime EMULY_BASE_URL
  // override never reaches it. Opting into per-request rendering there keeps hosted
  // prerendering (and its byte-for-byte output) unchanged.
  if (SELF_HOST) await connection();
  return new Response(buildDevicePrompt(env.baseUrl), { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
