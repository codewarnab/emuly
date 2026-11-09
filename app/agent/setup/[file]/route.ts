import type { NextRequest } from "next/server";
import { setupOs } from "../../../../lib/agent-runbook";

const MD = { "content-type": "text/markdown; charset=utf-8" };

/** Serves the key setup commands for one OS, for example /agent/setup/windows.md. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/agent/setup/[file]">) {
  const { file } = await ctx.params;
  const doc = setupOs(file.endsWith(".md") ? file.slice(0, -3) : null);
  if (!doc) return new Response("# Not found\n\nNo setup guide exists for this OS.\n", { status: 404, headers: MD });
  return new Response(doc, { headers: MD });
}
