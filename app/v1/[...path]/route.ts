import { unknownRouteBody } from "@/lib/v1-routes";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

// A route handler cannot render app/not-found.tsx (notFound() here sends an empty body), so a browser gets this page.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Page not found · Emuly</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;
background:#fafafa;color:#111;padding:16px}@media(prefers-color-scheme:dark){body{background:#0b0b0b;color:#eee}a{color:#9cf}}</style></head>
<body><main><p>ERROR 404</p><h1>This link leads nowhere.</h1><p><a href="/">Go to homepage</a></p></main></body></html>`;

/**
 * A /v1 path that no route has. A browser gets a 404 page. An agent (any client that does not
 * ask for HTML) gets JSON with the nearest routes and the full list, so it can fix the call.
 */
function route(request: Request) {
  if ((request.headers.get("accept") ?? "").includes("text/html")) {
    return new Response(PAGE, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return Response.json(unknownRouteBody(request.method, new URL(request.url).pathname), { status: 404 });
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
const counted = withApiUsage(route);
export { counted as GET, counted as POST, counted as PUT, counted as PATCH, counted as DELETE };
