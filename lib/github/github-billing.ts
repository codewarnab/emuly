import "server-only";
import { githubFetch } from "./github.ts";

export type BillingUsage = {
  coreHours: number; storageGbMonths: number;
  grossAmount: number; discountAmount: number; netAmount: number;
};
export type BillingResult = {
  usage: BillingUsage | null; plan: string | null; checkedAt: number;
  unavailable: "permission" | "temporary" | null;
};

export function planAllowance(plan: string | null) {
  return plan === "pro" ? { coreHours: 180, storageGbMonths: 20 }
    : { coreHours: 120, storageGbMonths: 15 };
}

export function quotaState(used: number, included: number, netAmount = 0) {
  if (netAmount > 0) return "paid";
  return included <= 0 || used >= included * 0.8 ? "low" : "healthy";
}

/** Reject unknown units rather than display an incomplete report as exact usage. */
export function parseBillingUsage(payload: unknown, month: string): BillingUsage {
  const data = payload as { usageItems?: unknown[] } | null;
  if (!Array.isArray(data?.usageItems)) throw new Error("Invalid billing report");
  const totals: BillingUsage = { coreHours: 0, storageGbMonths: 0, grossAmount: 0, discountAmount: 0, netAmount: 0 };
  for (const value of data.usageItems) {
    if (!value || typeof value !== "object") throw new Error("Invalid billing item");
    const item = value as Record<string, unknown>;
    if (typeof item.product !== "string" || item.product.toLowerCase() !== "codespaces") continue;
    if (typeof item.date !== "string" || !Number.isFinite(Date.parse(item.date))) throw new Error("Invalid billing date");
    if (new Date(item.date).toISOString().slice(0, 7) !== month) continue;
    for (const key of ["quantity", "grossAmount", "discountAmount", "netAmount"]) {
      if (typeof item[key] !== "number" || !Number.isFinite(item[key]) || Number(item[key]) < 0) {
        throw new Error("Invalid billing quantity or amount");
      }
    }
    const sku = String(item.sku).toLowerCase();
    const unit = String(item.unitType).toLowerCase().replace(/[ _-]/g, "");
    const quantity = Number(item.quantity);
    if (sku.includes("storage") || unit.startsWith("gb")) {
      if (unit === "gbmonth" || unit === "gbmonths") totals.storageGbMonths += quantity;
      else if (unit === "gbhour" || unit === "gbhours") {
        const [year, number] = month.split("-").map(Number);
        totals.storageGbMonths += quantity / (new Date(Date.UTC(year, number, 0)).getUTCDate() * 24);
      } else throw new Error("Unknown storage unit");
    } else if (unit === "corehours" || unit === "corehour") totals.coreHours += quantity;
    else {
      const cores = sku.match(/(?:compute[_ -]d|[ _-])(2|4|8|16|32)(?:[ _-]?core|$)/)?.[1];
      if (!cores || !["hour", "hours"].includes(unit)) throw new Error("Unknown compute unit");
      // Machine-hours are weighted by core count; core-hours are already weighted.
      totals.coreHours += quantity * Number(cores);
    }
    totals.grossAmount += Number(item.grossAmount);
    totals.discountAmount += Number(item.discountAmount);
    totals.netAmount += Number(item.netAmount);
  }
  return totals;
}

/** Per-user, month, and credential cache. Never retain token values in cache keys. */
export function createBillingClient({ accessToken, fetch: fetcher = fetch, clock = Date.now }: {
  accessToken: (userId: number) => Promise<string>; fetch?: typeof fetch; clock?: () => number;
}) {
  const cache = new Map<number, { key: string; result: Promise<BillingResult>; expires: number }>();
  return {
    invalidate(userId: number) { cache.delete(userId); },
    async read(user: { id: number; login: string; scopes: string }): Promise<BillingResult> {
      const now = clock();
      const month = new Date(now).toISOString().slice(0, 7);
      const key = `${user.login}:${user.scopes}:${month}`;
      const cached = cache.get(user.id);
      if (cached?.key === key && cached.expires > now) return cached.result;
      for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
      const result = load(user, month, now);
      cache.set(user.id, { key, result, expires: now + 10 * 60_000 });
      return result;
    },
  };

  async function load(user: { id: number; login: string; scopes: string }, month: string, checkedAt: number): Promise<BillingResult> {
    let plan: string | null = null;
    try {
      const token = await accessToken(user.id);
      const request = (path: string) => githubFetch(`https://api.github.com${path}`, { headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "emuly",
      } }, fetcher);
      const profile = await request("/user");
      if (profile.ok) {
        const data = await profile.json();
        if (data.plan?.name === "free" || data.plan?.name === "pro") plan = data.plan.name;
      } else await profile.body?.cancel();
      if (!user.scopes.split(/[ ,]+/).includes("user")) {
        return { usage: null, plan, checkedAt, unavailable: "permission" };
      }
      const [year, number] = month.split("-");
      const response = await request(`/users/${encodeURIComponent(user.login)}/settings/billing/usage?year=${year}&month=${Number(number)}`);
      if (!response.ok) {
        await response.body?.cancel();
        return { usage: null, plan, checkedAt, unavailable: [401, 403, 404].includes(response.status) ? "permission" : "temporary" };
      }
      return { usage: parseBillingUsage(await response.json(), month), plan, checkedAt, unavailable: null };
    } catch {
      // Provider bodies and credentials must never reach the client or logs.
      return { usage: null, plan, checkedAt, unavailable: "temporary" };
    }
  }
}
