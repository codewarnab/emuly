/**
 * Every agent route under /v1, for the JSON 404 that an agent gets on a wrong path.
 * `v1-routes.test.ts` checks this list against the route files in `app/v1/`.
 * `{id}` stands for a phone or webhook id. The Apps routes live in `phones/[id]/[...apps]`.
 */
export const V1_ROUTES: readonly string[] = [
  "POST /v1/agent/device", "POST /v1/agent/device/token", "POST /v1/agent/setup-code", "POST /v1/agent/token",
  "GET /v1/cli", "GET /v1/me", "GET /v1/usage", "GET /v1/settings", "PATCH /v1/settings", "POST /v1/update/dismiss",
  "GET /v1/phones", "POST /v1/phones", "GET /v1/phones/{id}", "DELETE /v1/phones/{id}",
  "POST /v1/phones/{id}/start", "POST /v1/phones/{id}/stop", "POST /v1/phones/{id}/keep",
  "POST /v1/phones/{id}/adb", "POST /v1/phones/{id}/adb/upload",
  "GET /v1/phones/{id}/screenshot", "GET /v1/phones/{id}/ui", "GET /v1/phones/{id}/agent-device",
  "GET /v1/phones/{id}/app-events", "GET /v1/phones/{id}/net-check",
  "POST /v1/phones/{id}/delete-requests", "GET /v1/phones/{id}/delete-requests/{requestId}",
  "GET /v1/phones/{id}/links", "POST /v1/phones/{id}/links", "DELETE /v1/phones/{id}/links", "GET /v1/phones/{id}/links/relay",
  "GET /v1/phones/{id}/proxy", "POST /v1/phones/{id}/proxy", "DELETE /v1/phones/{id}/proxy", "POST /v1/phones/{id}/proxy/check",
  "POST /v1/phones/{id}/recording/{start|stop|mark|discard}", "GET /v1/phones/{id}/recording/{status|file|grid|notes}",
  "GET /v1/phones/{id}/apps", "POST /v1/phones/{id}/apps/open", "POST /v1/phones/{id}/apps/update",
  "GET /v1/phones/{id}/app-installs", "POST /v1/phones/{id}/app-installs", "GET /v1/phones/{id}/app-installs/{operationId}",
  "PUT /v1/phones/{id}/app-installs/{operationId}/content", "POST /v1/phones/{id}/app-installs/{operationId}/complete",
  "POST /v1/phones/{id}/app-installs/{operationId}/cancel",
  "GET /v1/phones/{id}/file-fetches", "POST /v1/phones/{id}/file-fetches", "GET /v1/phones/{id}/file-fetches/{fetchId}",
  "POST /v1/phones/{id}/file-fetches/{fetchId}/cancel",
  "GET /v1/webhooks", "POST /v1/webhooks", "GET /v1/webhooks/{id}", "PATCH /v1/webhooks/{id}", "DELETE /v1/webhooks/{id}",
  "POST /v1/webhooks/{id}/test", "GET /v1/webhooks/{id}/deliveries", "POST /v1/webhooks/{id}/deliveries/{deliveryId}/resend",
];

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** The routes nearest to a wrong path. Segments after a known parent count as ids. */
export function nearRoutes(path: string, limit = 5): string[] {
  const asked = path.split("?")[0].replace(/\/+$/, "").split("/");
  const score = (route: string) => {
    const known = route.split(" ")[1].split("/");
    // An id segment in the route matches any value in the path.
    const shaped = asked.map((part, i) => known[i]?.startsWith("{") ? known[i] : part).join("/");
    return distance(shaped, known.join("/"));
  };
  return [...V1_ROUTES].map(route => ({ route, cost: score(route) })).sort((a, b) => a.cost - b.cost)
    .slice(0, limit).map(item => item.route);
}

/** The JSON that an agent gets for a path that no /v1 route has. */
export function unknownRouteBody(method: string, path: string) {
  return { error: "not_found", message: `No route ${method} ${path}. The nearest routes are in near, and every route is in routes.`,
    near: nearRoutes(path), routes: V1_ROUTES };
}
