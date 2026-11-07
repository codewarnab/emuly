import "server-only";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { db } from "./db";
import { cookieName, cookieOptions } from "./auth-cookies";
import { insertSession, readSession, deleteSession, SESSION_MAX_AGE } from "./session-store.ts";

export async function createSession(userId: number) {
  const store = await cookies();
  // Rotate the current browser session on each successful sign-in.
  deleteSession(db(), store.get(cookieName("session"))?.value);
  const session = insertSession(db(), userId);
  store.set(cookieName("session"), session.value, cookieOptions(SESSION_MAX_AGE));
}

export async function getSession() {
  await connection();
  const value = (await cookies()).get(cookieName("session"))?.value;
  return value ? readSession(db(), value) : null;
}

export async function destroySession() {
  const store = await cookies();
  deleteSession(db(), store.get(cookieName("session"))?.value);
  store.set(cookieName("session"), "", cookieOptions(0));
}
