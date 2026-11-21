import { connection } from "next/server";
import { env } from "../../lib/env";
import { SELF_HOST } from "../../lib/selfhost";
import { homeMarkdown, selfHostMarkdown } from "../../lib/site-content";
import { skillFile } from "../../lib/agent-runbook";
import { buildDevicePrompt } from "../../lib/agent-prompt";
import { SELF_HOST_SETUP_PROMPT } from "../../lib/selfhost-setup-prompt";

/** Every public doc in one file, for agents that read one URL only. */
export async function GET() {
  if (SELF_HOST) await connection();
  const b = env.baseUrl;
  const parts = [homeMarkdown(b), "# Agent setup prompt\n\n" + buildDevicePrompt(b), skillFile("SKILL.md", b) ?? "", selfHostMarkdown(b, SELF_HOST_SETUP_PROMPT)];
  return new Response(parts.join("\n\n---\n\n"), { headers: { "cache-control": "public, s-maxage=3600", "content-type": "text/plain; charset=utf-8" } });
}
