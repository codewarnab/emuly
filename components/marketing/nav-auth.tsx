"use client";
import Link from "next/link";
import { useSyncExternalStore } from "react";

const HINT = "emuly_signed_in";
const subscribe = () => () => {};
const signedIn = () => document.cookie.split("; ").some(c => c === `${HINT}=1`);

/** The landing page is static, so the nav reads a non-secret hint cookie in the browser.
    The server render holds the space and shows neither link, so no wrong link flashes. */
export function NavAuth({ selfHost }: { selfHost: boolean }) {
  const state = useSyncExternalStore(subscribe, () => (selfHost || signedIn() ? "in" : "out"), () => "unknown");
  if (state === "unknown") return <span aria-hidden="true" style={{ visibility: "hidden" }}>Console</span>;
  return state === "in" ? <Link href="/app">Console</Link> : <Link href="/login">Sign in</Link>;
}
