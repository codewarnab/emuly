import type { NextRequest } from "next/server";
import { SKILL_NAME, skillFile, skillIndex } from "../../../../lib/agent-runbook";

const MD = { "content-type": "text/markdown; charset=utf-8" };
const REGISTRIES = ["skills", "agent-skills"];

/**
 * Agent Skills discovery, so `npx skills add <base url>` can install the skill:
 * /.well-known/skills/index.json and /.well-known/skills/emuly-playbook/<file>.
 * agent-skills is the newer name of the same folder.
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/.well-known/[registry]/[...path]">) {
  const { registry, path } = await ctx.params;
  if (!REGISTRIES.includes(registry)) return new Response("Not found", { status: 404 });
  if (path.length === 1 && path[0] === "index.json") return Response.json(skillIndex());
  const doc = path[0] === SKILL_NAME ? skillFile(path.slice(1).join("/")) : null;
  if (!doc) return new Response("# Not found\n", { status: 404, headers: MD });
  return new Response(doc, { headers: MD });
}
