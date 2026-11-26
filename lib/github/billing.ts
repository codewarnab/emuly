import "server-only";
import { asyncDb } from "../data/async-db.ts";
import { getAccessToken } from "./github-token.ts";
import { loadAccountUsage } from "./account-usage.ts";
import { createBillingClient } from "./github-billing.ts";

const global = globalThis as unknown as { __billing?: ReturnType<typeof createBillingClient> };
export const billingClient = global.__billing ??= createBillingClient({ accessToken: getAccessToken });

export function readAccountUsage(user: { id: number; login: string }, clock = Date.now) {
  return loadAccountUsage(asyncDb(), user => billingClient.read(user), user, clock);
}

export type AccountUsage = Awaited<ReturnType<typeof readAccountUsage>>["usage"];
