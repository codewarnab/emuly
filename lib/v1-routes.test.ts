import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { nearRoutes, unknownRouteBody, V1_ROUTES } from "./v1-routes.ts";

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routeFiles(path) : name === "route.ts" ? [path] : [];
  });
}

test("the route list covers every method that each app/v1 route file exports", () => {
  const listed = new Set(V1_ROUTES.map(route => route.replace(/\{[^}]+\}/g, "{}")));
  for (const file of routeFiles("app/v1")) {
    const dir = file.replaceAll("\\", "/").replace(/^app/, "").replace(/\/route\.ts$/, "");
    // Catch-alls and the recording actions are listed by hand.
    if (dir.includes("[...") || dir.includes("[action]")) continue;
    const path = dir.replace(/\[[^\]]+\]/g, "{}");
    const source = readFileSync(file, "utf8");
    const methods = [...source.matchAll(/export (?:async function|const) (GET|POST|PUT|PATCH|DELETE)\b/g)].map(match => match[1]);
    assert.ok(methods.length, file);
    for (const method of methods) assert.ok(listed.has(`${method} ${path}`), `${method} ${path} is missing from V1_ROUTES`);
  }
});

test("a wrong path names the nearest real routes", () => {
  assert.equal(nearRoutes("/v1/phones/phone-a1b2/screenshoot")[0], "GET /v1/phones/{id}/screenshot");
  assert.equal(nearRoutes("/v1/phone")[0].split(" ")[1], "/v1/phones");
  assert.ok(nearRoutes("/v1/phones/phone-a1b2/adb/uplod").includes("POST /v1/phones/{id}/adb/upload"));
  const body = unknownRouteBody("POST", "/v1/nope");
  assert.equal(body.error, "not_found");
  assert.equal(body.routes, V1_ROUTES);
});
