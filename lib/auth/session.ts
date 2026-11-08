import "server-only";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { asyncDb } from "../data/async-db.ts";
import { transaction } from "../data/async-database.ts";
import { cookieName, cookieOptions } from "./auth-cookies";
import { insertSession, readSession, deleteSession, SESSION_MAX_AGE } from "./session-store.ts";

export async function createSession(userId: number) {
  const store = await cookies();
  // Rotate the current browser session on each successful sign-in.
  const session = await transaction(asyncDb(), async queries => {
    await deleteSession(queries, store.get(cookieName("session"))?.value);
    return insertSession(queries, userId);
  });
  store.set(cookieName("session"), session.value, cookieOptions(SESSION_MAX_AGE));
}

export async function getSession() {
  await connection();
  const value = (await cookies()).get(cookieName("session"))?.value;
  return value ? readSession(asyncDb(), value) : null;
}

export async function destroySession() {
  const store = await cookies();
  await deleteSession(asyncDb(), store.get(cookieName("session"))?.value);
  store.set(cookieName("session"), "", cookieOptions(0));
}
