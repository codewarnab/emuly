import { connection } from "next/server";
import { env } from "../../lib/env";
import { SELF_HOST } from "../../lib/selfhost";
import { llmsTxt } from "../../lib/site-content";
import { skillUrl } from "../../lib/agent-runbook";

/** The llmstxt.org index for AI agents. Self-host renders per request, like /agent.md. */
export async function GET() {
  if (SELF_HOST) await connection();
  return new Response(llmsTxt(env.baseUrl, skillUrl(env.baseUrl)), { headers: { "cache-control": "public, s-maxage=3600", "content-type": "text/plain; charset=utf-8" } });
}
