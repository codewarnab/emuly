/*
 * One GitHub account per phonelink user — on purpose.
 *
 * Linking several GitHub accounts to pool their free Codespaces hours would mean one
 * person holding several free accounts, which GitHub's Terms of Service do not allow
 * ("one person or legal entity may maintain no more than one free Account"). That would
 * put users' accounts and our OAuth app at risk.
 *   Terms: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
 *   Codespaces billing: https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces
 *
 * If we add a second account later, it must be one where someone else pays (an
 * organization that bills Codespaces to itself, or the user's own paid usage), never a
 * second free personal account. Re-read the Terms before building it.
 */
import "server-only";
import type { DatabaseSync } from "node:sqlite";

/** The only GitHub HTTP transport, including OAuth. Tests supply a fake fetch. */
export function githubFetch(url: string, init: RequestInit, fetcher: typeof fetch = fetch) {
  const target = new URL(url);
  if (target.protocol !== "https:" || !["api.github.com", "github.com"].includes(target.host)) {
    throw new Error("Invalid GitHub URL");
  }
  return fetcher(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export type Codespace = {
  id: number;
  name: string;
  display_name?: string;
  state: string;
  machine?: { name: string; cpus: number } | null;
  retention_expires_at?: string | null;
  last_used_at?: string;
};
export type Machine = { name: string; display_name: string; cpus: number; memory_in_bytes: number };
export type CreateCodespace = {
  repository_id: number;
  machine: string;
  devcontainer_path: string;
  idle_timeout_minutes: number;
  retention_period_minutes: number;
};

export function createGitHubClient({ database, accessToken, fetch: fetcher = fetch }: {
  database: DatabaseSync;
  accessToken: (userId: number) => Promise<string>;
  fetch?: typeof fetch;
}) {
  async function request(userId: number, path: string, method = "GET", body?: unknown) {
    const token = await accessToken(userId);
    const response = await githubFetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "phonelink-local",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, fetcher);
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const message = typeof data?.message === "string" ? data.message : `GitHub request failed (${response.status})`;
      throw new GitHubError(message.replaceAll(token, "[redacted]"), response.status);
    }
    return response;
  }

  function assertOwnedCodespace(userId: number, phoneId: string) {
    const phone = database.prepare(`SELECT codespace_name, state FROM phones
      WHERE user_id = ? AND id = ? AND state != 'deleted'`).get(userId, phoneId) as
      { codespace_name: string; state: string } | undefined;
    if (!phone) throw new Error("Phone not found");
    return phone;
  }

  async function getCodespace(userId: number, phoneId: string) {
    const phone = assertOwnedCodespace(userId, phoneId);
    return readCodespace(await request(userId, `/user/codespaces/${encodeURIComponent(phone.codespace_name)}`));
  }

  async function mutate(userId: number, phoneId: string, operation: "start" | "stop") {
    const phone = assertOwnedCodespace(userId, phoneId);
    const response = await request(userId, `/user/codespaces/${encodeURIComponent(phone.codespace_name)}/${operation}`, "POST");
    // Stop commonly returns 202 with no JSON. Reconcile with GET before claiming Shutdown.
    if (operation === "stop") { await response.body?.cancel(); return; }
    return readCodespace(response);
  }

  return {
    assertOwnedCodespace,
    getCodespace,
    async listCodespaces(userId: number): Promise<Codespace[]> {
      const names = new Set(database.prepare("SELECT codespace_name FROM phones WHERE user_id = ? AND state != 'deleted'")
        .all(userId).map(row => String(row.codespace_name)));
      const displays = new Set(database.prepare(`SELECT c.display_name FROM phone_creations c
        JOIN phones p ON p.id = c.phone_id WHERE p.user_id = ? AND p.state != 'deleted'
        AND c.outcome = 'unconfirmed'`).all(userId).map(row => String(row.display_name)));
      const result: Codespace[] = [];
      let more = true;
      for (let page = 1; more; page++) {
        const response = await request(userId, `/user/codespaces?per_page=100&page=${page}`);
        const data = await response.json();
        if (!Array.isArray(data.codespaces)) throw new Error("Invalid GitHub codespaces response");
        // GitHub generates identifiers without our prefix. See docs/SPIKE-RESULTS.md.
        for (const item of data.codespaces) {
          if (names.has(item.name) || displays.has(item.display_name)) result.push(validateCodespace(item));
        }
        more = /rel="next"/.test(response.headers.get("link") ?? "");
      }
      return result;
    },
    async machines(userId: number, repository: string): Promise<Machine[]> {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
      // The account endpoint returned 404 in the spike; the repository endpoint works.
      const response = await request(userId, `/repos/${repository}/codespaces/machines`);
      const data = await response.json();
      if (!Array.isArray(data.machines) || !data.machines.every((m: Machine) =>
        typeof m.name === "string" && Number.isSafeInteger(m.cpus) && m.cpus > 0)) {
        throw new Error("Invalid GitHub machines response");
      }
      return data.machines;
    },
    async createCodespace(userId: number, phoneId: string, input: CreateCodespace) {
      const phone = assertOwnedCodespace(userId, phoneId);
      const operation = database.prepare("SELECT display_name, outcome FROM phone_creations WHERE phone_id = ?").get(phoneId);
      if (phone.state !== "pending" || phone.codespace_name !== `pending:${phoneId}`) {
        throw new Error("Phone creation already requested");
      }
      if (operation?.outcome !== "unconfirmed") throw new Error("Phone creation intent must be persisted before HTTP");
      return readCodespace(await request(userId, "/user/codespaces", "POST", { ...input, display_name: operation.display_name }));
    },
    startCodespace: (userId: number, phoneId: string) => mutate(userId, phoneId, "start"),
    stopCodespace: (userId: number, phoneId: string) => mutate(userId, phoneId, "stop"),
  };
}

async function readCodespace(response: Response): Promise<Codespace> {
  return validateCodespace(await response.json());
}

function validateCodespace(value: Codespace): Codespace {
  if (!value || typeof value.name !== "string" || !value.name || typeof value.state !== "string"
    || !Number.isSafeInteger(value.id)) throw new Error("Invalid GitHub codespace response");
  if (value.machine && (!Number.isSafeInteger(value.machine.cpus) || value.machine.cpus < 1)) {
    throw new Error("Invalid GitHub machine core count");
  }
  return value;
}
