import { connection } from "next/server";
import { env } from "../../lib/env";
import { SELF_HOST } from "../../lib/selfhost";
import { homeMarkdown } from "../../lib/site-content";

/** The landing page as Markdown. GET / with Accept: text/markdown also lands here. */
export async function GET() {
  if (SELF_HOST) await connection();
  return new Response(homeMarkdown(env.baseUrl), { headers: { "content-type": "text/markdown; charset=utf-8", vary: "Accept" } });
}
