import type { NextRequest } from "next/server";
import { setupMarkdown } from "../../../lib/docs/agent-setup";

/** Plain Markdown setup steps that a coding agent can fetch and follow. */
export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  return new Response(setupMarkdown(params.get("agent"), params.get("os")), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
