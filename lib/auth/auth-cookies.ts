import "server-only";
import { env } from "../env";

export function cookieName(kind: "session" | "state" | "billing" | "next") {
  return `${env.cookieInsecure ? "" : "__Host-"}emuly_${kind}`;
}

export function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: !env.cookieInsecure, sameSite: "lax" as const, path: "/", maxAge };
}
