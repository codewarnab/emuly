import "server-only";
import { env } from "../env";

export function cookieName(kind: "session" | "state" | "next" | "last") {
  return `${env.cookieInsecure ? "" : "__Host-"}emuly_${kind}`;
}

export function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: !env.cookieInsecure, sameSite: "lax" as const, path: "/", maxAge };
}

/** A readable "signed in" hint for static pages. It holds no secret: the session cookie
    stays httpOnly and is the only thing that grants access. */
export const SIGNED_IN_HINT = "emuly_signed_in";
export function hintCookieOptions(maxAge: number) {
  return { httpOnly: false, secure: !env.cookieInsecure, sameSite: "lax" as const, path: "/", maxAge };
}
