import "server-only";
import { env } from "./env.ts";

export class SignInError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("GitHub sign-in failed");
    this.code = code;
  }
}

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  scopes: string;
};

export async function exchangeTokens(parameters: Record<string, string>): Promise<TokenPair> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "User-Agent": "phonelink-local" },
    body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, ...parameters }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new SignInError("exchange");
  const data: unknown = await response.json();
  if (!isRecord(data) || data.error) throw new SignInError("exchange");
  if (typeof data.scope !== "string" || !data.scope.split(/[ ,]+/).includes("codespace")) {
    throw new SignInError("scope");
  }
  if (!nonempty(data.access_token) || !nonempty(data.refresh_token)
    || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer") {
    throw new SignInError("exchange");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAt: expiry(data.expires_in),
    refreshExpiresAt: expiry(data.refresh_token_expires_in),
    scopes: data.scope,
  };
}

export async function githubGet(path: "/user" | "/user/codespaces?per_page=1", token: string) {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "phonelink-local",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
}

export async function githubIdentity(token: string) {
  const response = await githubGet("/user", token);
  if (response.status !== 200) throw new SignInError("user");
  const data: unknown = await response.json();
  if (!isRecord(data) || !Number.isSafeInteger(data.id) || Number(data.id) <= 0
    || !nonempty(data.login) || data.type !== "User") throw new SignInError("user");
  return {
    githubId: data.id as number,
    login: data.login,
    name: typeof data.name === "string" ? data.name : null,
    avatarUrl: typeof data.avatar_url === "string" ? data.avatar_url : null,
  };
}

function isRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function expiry(seconds: unknown) {
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new SignInError("exchange");
  }
  const milliseconds = Date.now() + seconds * 1000;
  if (milliseconds > 8.64e15) throw new SignInError("exchange");
  return new Date(milliseconds).toISOString();
}
