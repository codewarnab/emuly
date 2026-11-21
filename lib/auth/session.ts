import "server-only";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { asyncDb } from "../data/async-db.ts";
import { transaction } from "../data/async-database.ts";
import { cookieName, cookieOptions, SIGNED_IN_HINT, hintCookieOptions } from "./auth-cookies";
import { insertSession, readSession, deleteSession, SESSION_MAX_AGE } from "./session-store.ts";
import { SELF_HOST, selfHostUser } from "../selfhost.ts";

export async function createSession(userId: number) {
  const store = await cookies();
  // Rotate the current browser session on each successful sign-in.
  const session = await transaction(asyncDb(), async queries => {
    await deleteSession(queries, store.get(cookieName("session"))?.value);
    return insertSession(queries, userId);
  });
  store.set(cookieName("session"), session.value, cookieOptions(SESSION_MAX_AGE));
  store.set(SIGNED_IN_HINT, "1", hintCookieOptions(SESSION_MAX_AGE));
}

export async function getSession() {
  await connection();
  // Self-host has no session cookie. selfHostUser upserts the constant "self-host"
  // row in the sessions table (the stream validators compare that table) and the user
  // id points at the one gh identity. The expiry is a constant, not Date.now():
  // an unstable value would break prerendering of pages that only touch the session.
  if (SELF_HOST) {
    return { id: "self-host", userId: (await selfHostUser(asyncDb())).id, expiresAt: "9999-12-31T23:59:59.999Z" };
  }
  const value = (await cookies()).get(cookieName("session"))?.value;
  return value ? readSession(asyncDb(), value) : null;
}

export async function destroySession() {
  const store = await cookies();
  await deleteSession(asyncDb(), store.get(cookieName("session"))?.value);
  store.set(cookieName("session"), "", cookieOptions(0));
  store.set(SIGNED_IN_HINT, "", hintCookieOptions(0));
}
