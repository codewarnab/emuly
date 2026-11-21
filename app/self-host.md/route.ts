import { connection } from "next/server";
import { env } from "../../lib/env";
import { SELF_HOST } from "../../lib/selfhost";
import { selfHostMarkdown } from "../../lib/site-content";
import { SELF_HOST_SETUP_PROMPT } from "../../lib/selfhost-setup-prompt";

/** The self-host page as Markdown. GET /self-host with Accept: text/markdown also lands here. */
export async function GET() {
  if (SELF_HOST) await connection();
  return new Response(selfHostMarkdown(env.baseUrl, SELF_HOST_SETUP_PROMPT), { headers: { "content-type": "text/markdown; charset=utf-8", vary: "Accept" } });
}
