import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { db } from "./db";
import { getSession } from "./session";

export const getUser = cache(async () => {
  const session = await getSession();
  if (!session) return null;
  const row = db().prepare("SELECT id, login, name, avatar_url FROM users WHERE id = ? AND blocked = 0")
    .get(session.userId) as { id: number; login: string; name: string | null; avatar_url: string | null } | undefined;
  if (!row) return null;
  const initials = (row.name?.trim().split(/\s+/).map(part => Array.from(part)[0]).slice(0, 2).join("")
    || row.login.slice(0, 2)).toUpperCase();
  return { id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url, initials };
});

export const requireUser = cache(async () => {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
});
