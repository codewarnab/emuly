import type { NextRequest } from "next/server";
import { agentRunbook } from "../../lib/agent-runbook";

/** Static runbook that a coding agent fetches and follows. */
export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  return new Response(agentRunbook(params.get("os"), params.get("agent")), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
