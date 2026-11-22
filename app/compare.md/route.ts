import { connection } from "next/server";
import { env } from "../../lib/env";
import { SELF_HOST } from "../../lib/selfhost";
import { compareMarkdown } from "../../lib/compare-content";

/** The compare page as Markdown, for AI agents. */
export async function GET() {
  if (SELF_HOST) await connection();
  return new Response(compareMarkdown(env.baseUrl), { headers: { "cache-control": "public, s-maxage=3600", "content-type": "text/markdown; charset=utf-8", vary: "Accept" } });
}
