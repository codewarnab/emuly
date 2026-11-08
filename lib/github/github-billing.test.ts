import { test } from "node:test";
import assert from "node:assert/strict";
import { createBillingClient, parseBillingUsage, planAllowance, quotaState } from "./github-billing.ts";

const item = (extra = {}) => ({ date: "2026-11-02", product: "codespaces", sku: "codespaces_compute_d4",
  quantity: 3, unitType: "hours", grossAmount: 1.08, discountAmount: 1, netAmount: 0.08, ...extra });

test("billing separates weighted compute, storage and costs for this UTC month", () => {
  const report = parseBillingUsage({ usageItems: [item(),
    item({ sku: "Codespaces 2-core", quantity: 2, grossAmount: 0, discountAmount: 0, netAmount: 0 }),
    item({ unitType: "core-hours", quantity: 5, grossAmount: 0, discountAmount: 0, netAmount: 0 }),
    item({ sku: "codespaces_storage", unitType: "GB-month", quantity: 2, grossAmount: 0.14, discountAmount: 0.14, netAmount: 0 }),
    item({ sku: "codespaces_prebuild_storage", unitType: "GB-hours", quantity: 720, grossAmount: 0.07, discountAmount: 0.07, netAmount: 0 }),
    item({ date: "2026-10-31" }), item({ date: "2026-12-01" }), item({ product: "actions" }),
  ] }, "2026-11");
  assert.equal(report.coreHours, 21);
  assert.equal(report.storageGbMonths, 3);
  assert.ok(Math.abs(report.grossAmount - 1.29) < 1e-9);
  assert.ok(Math.abs(report.discountAmount - 1.21) < 1e-9);
  assert.equal(report.netAmount, 0.08);
  assert.deepEqual(parseBillingUsage({ usageItems: [] }, "2026-11"), {
    coreHours: 0, storageGbMonths: 0, grossAmount: 0, discountAmount: 0, netAmount: 0,
  });
  for (const invalid of [null, {}, { usageItems: [item({ quantity: -1 })] },
    { usageItems: [item({ unitType: "minutes" })] }, { usageItems: [item({ date: "bad" })] },
    { usageItems: [item({ sku: "future", unitType: "hours" })] }]) {
    assert.throws(() => parseBillingUsage(invalid, "2026-11"));
  }
});

test("plans map to included compute and storage; unknown plans use an unverified Free default", () => {
  assert.deepEqual(planAllowance("free"), { coreHours: 120, storageGbMonths: 15 });
  assert.deepEqual(planAllowance("pro"), { coreHours: 180, storageGbMonths: 20 });
  assert.deepEqual(planAllowance(null), { coreHours: 120, storageGbMonths: 15 });
  assert.deepEqual(planAllowance("future"), { coreHours: 120, storageGbMonths: 15 });
});

test("quota has an inclusive 20 percent warning and paid costs take precedence", () => {
  assert.equal(quotaState(79.99, 100), "healthy");
  for (const used of [80, 100, 110]) assert.equal(quotaState(used, 100), "low");
  assert.equal(quotaState(0, 0), "low");
  assert.equal(quotaState(1, 120, 0.001), "paid");
});

test("billing requests documented headers and month; cache isolates users, expires and invalidates", async () => {
  let now = Date.parse("2026-11-07T00:00:00Z");
  const requests: string[] = [];
  const client = createBillingClient({ accessToken: async id => `synthetic-${id}`, clock: () => now,
    fetch: async (input, init) => {
      const url = new URL(String(input)); requests.push(url.pathname);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Accept"), "application/vnd.github+json");
      assert.equal(headers.get("X-GitHub-Api-Version"), "2026-03-10");
      assert.equal(init?.cache, "no-store");
      if (url.pathname === "/user") return Response.json({ plan: { name: "pro" } });
      assert.equal(url.searchParams.get("year"), "2026");
      assert.equal(url.searchParams.get("month"), String(new Date(now).getUTCMonth() + 1));
      return Response.json({ usageItems: [item()] });
    } });
  const user = { id: 1, login: "fixture", scopes: "codespace,user" };
  const [a, b] = await Promise.all([client.read(user), client.read(user)]);
  assert.deepEqual(a, b); assert.equal(a.usage?.coreHours, 12); assert.equal(a.plan, "pro");
  assert.equal(requests.length, 2);
  await client.read({ ...user, id: 2 }); assert.equal(requests.length, 4);
  now += 600_000; await client.read(user); assert.equal(requests.length, 6);
  client.invalidate(1); await client.read(user); assert.equal(requests.length, 8);
  now = Date.parse("2026-12-01T00:00:00Z");
  assert.equal((await client.read(user)).usage?.coreHours, 0);
});

test("missing scope and rejected billing fall back without preventing plan detection or login", async () => {
  for (const status of [401, 403, 404, 500, 200]) {
    const client = createBillingClient({ accessToken: async () => "synthetic",
      fetch: async input => String(input).endsWith("/user")
        ? Response.json({ plan: { name: "pro" } })
        : Response.json(status === 200 ? { invalid: true } : {}, { status }) });
    const result = await client.read({ id: 1, login: "fixture", scopes: "codespace user" });
    assert.equal(result.usage, null); assert.equal(result.plan, "pro");
    assert.equal(result.unavailable, status < 500 && status !== 200 ? "permission" : "temporary");
  }
  let calls = 0;
  const client = createBillingClient({ accessToken: async () => "synthetic",
    fetch: async () => { calls++; return Response.json({}); } });
  assert.equal((await client.read({ id: 1, login: "fixture", scopes: "codespace" })).unavailable, "permission");
  assert.equal(calls, 1);
  const offline = createBillingClient({ accessToken: async () => "synthetic", fetch: async () => { throw new Error("offline"); } });
  assert.equal((await offline.read({ id: 2, login: "fixture", scopes: "user" })).unavailable, "temporary");
});
