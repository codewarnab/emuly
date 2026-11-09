import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession } from "./session";
import { bearerValue } from "./agent.ts";
import { resolveUser } from "./identity.ts";

// One GitHub account per user; see lib/github/github.ts for the Terms and billing rationale.
export const getUser = cache(async () => {
  const authorization = (await headers()).get("authorization");
  // An agent key alone decides the identity. A non-Bearer Authorization header still uses the cookie.
  const session = bearerValue(authorization) ? null : await getSession();
  return resolveUser({ authorization, session });
});

export const requireUser = cache(async () => {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
});
