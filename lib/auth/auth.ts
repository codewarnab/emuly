import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { connection } from "next/server";
import { getSession } from "./session";
import { bearerValue } from "./agent.ts";
import { resolveUser } from "./identity.ts";
import { SELF_HOST, selfHostUser } from "../selfhost.ts";
import { asyncDb } from "../data/async-db.ts";

// One GitHub account per user; see lib/github/github.ts for the Terms and billing rationale.
export const getUser = cache(async () => {
  // connection() first: a prerender stops here, before headers(). A headers() read in the
  // prerender would mark every dashboard route as session data, and then each <Link> sends a
  // runtime prefetch (a Vercel function call) that returns only the static shell it already has.
  // At request time connection() returns at once. Also keeps gh identity lookup and
  // first-use database initialization (self-host) out of prerendering.
  await connection();
  const authorization = (await headers()).get("authorization");
  // An agent key alone decides the identity, also in self-host. A non-Bearer
  // Authorization header still uses the cookie.
  if (bearerValue(authorization)) {
    const agent = await resolveUser({ authorization, session: null });
    if (agent || !SELF_HOST) return agent;
    // Self-host: a key from another Emuly server (often emuly.vercel.app) is not in this
    // database. The gh account is the only user here, so the call acts as that user. A browser
    // cannot send a Bearer header cross-site (no route allows CORS), so this opens no CSRF path.
    return { ...await selfHostUser(await asyncDb()), authKind: "agent" as const };
  }
  // Self-host has no cookie: the single identity comes from gh, and the first call upserts it.
  if (SELF_HOST) return selfHostUser(await asyncDb());
  return resolveUser({ authorization, session: await getSession() });
});

export const requireUser = cache(async () => {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
});
