import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAccountUsage } from "./account-usage.ts";
import type { BillingResult } from "./github-billing.ts";

function fakeDatabase(stored: { plan: string | null }) {
  const sql: string[] = [];
  let pending = 0, maxPending = 0;
  const database = {
    async execute({ sql: text, args }: { sql: string; args: unknown[] }) {
      sql.push(text);
      pending += 1; maxPending = Math.max(maxPending, pending);
      await new Promise(resolve => setImmediate(resolve));
      pending -= 1;
      if (text.startsWith("INSERT INTO billing_settings")) stored.plan = args[1] as string;
      if (text.includes("FROM billing_settings WHERE")) return { rows: stored.plan ? [{ plan_name: stored.plan, allowance_override: null }] : [] };
      if (text.includes("token_scopes")) return { rows: [{ token_scopes: "codespace" }] };
      if (text.includes("allowance_core_hours")) return { rows: [{ allowance_core_hours: stored.plan === "pro" ? 180 : 120,
        default_machine: null, default_idle_min: 30, auto_stop_before_empty: 0, auto_keep: 0, agent_delete_phones: 0 }] };
      return { rows: [] };
    },
  };
  return { database: database as never, sql, maxPending: () => maxPending };
}

const billing = (plan: string | null): BillingResult => ({ usage: null, plan, checkedAt: 0, unavailable: null });
const user = { id: 7, login: "octo" };

test("a dashboard load with an unchanged plan does no Turso write and runs the reads together", async () => {
  const fake = fakeDatabase({ plan: "pro" });
  let billingStartedWhileReading = false;
  const result = await loadAccountUsage(fake.database, async () => {
    billingStartedWhileReading = fake.sql.some(text => text.includes("FROM billing_settings WHERE"));
    return billing("pro");
  }, user, () => 0);
  assert.equal(fake.sql.filter(text => text.startsWith("INSERT")).length, 0, "same plan, no upsert");
  assert.ok(billingStartedWhileReading, "the GitHub billing read does not wait for the billing_settings read");
  assert.ok(fake.maxPending() >= 4, "the Turso reads overlap");
  assert.equal(result.usage.plan, "pro");
});

test("a changed plan is written, and this page already shows the new plan's allowance", async () => {
  const fake = fakeDatabase({ plan: "free" });
  const result = await loadAccountUsage(fake.database, async () => billing("pro"), user, () => 0);
  assert.equal(fake.sql.filter(text => text.startsWith("INSERT INTO billing_settings")).length, 1);
  assert.equal(result.usage.plan, "pro");
  assert.equal(result.usage.storage_included, 20);
  assert.equal(result.usage.allowance_core_hours, 180);
});
