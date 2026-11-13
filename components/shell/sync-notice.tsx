"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SyncError } from "@/lib/shared/sync-error";
import s from "@/components/console.module.css";

export function SyncNotice({ error }: { error: SyncError }) {
  const router = useRouter();
  const delay = Math.max(0, Math.ceil(error.retryAfter ?? 60));
  const [remaining, setRemaining] = useState(delay);
  const retried = useRef(false);
  const [retrying, startRetry] = useTransition();

  useEffect(() => {
    if (error.kind !== "busy" || retried.current) return;
    const deadline = Date.now() + delay * 1000;
    setRemaining(delay);
    const timer = setInterval(() => {
      if (retried.current) { clearInterval(timer); return; }
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0) {
        retried.current = true;
        clearInterval(timer);
        startRetry(() => router.refresh());
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [error.kind, delay, router]);

  function retry() {
    retried.current = true;
    setRemaining(0);
    startRetry(() => router.refresh());
  }

  const [title, ...rest] = error.message.split(/(?<=\.)\s+/);
  return <div role="status" className={s.syncNotice}>
    <svg className={s.syncIcon} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 8v4.5M12 16h.01" />
    </svg>
    <span className={s.syncText}>
      {title}
      {(rest.length > 0 || (error.kind === "busy" && remaining > 0)) && <small>
        {rest.join(" ")}{error.kind === "busy" && remaining > 0 && ` Retrying in ${remaining}s.`}
      </small>}
    </span>
    {error.kind === "signin" ? <a className={s.syncAction} href="/auth/start">Reconnect</a>
      : error.kind === "quota" ? <a className={s.syncAction}
        href="https://github.com/settings/billing/usage" target="_blank" rel="noreferrer">Open billing</a>
      : <button type="button" className={s.syncAction} onClick={retry} disabled={retrying} aria-busy={retrying}>
        <svg className={retrying ? s.syncSpin : undefined} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
        </svg>{retrying ? "Retrying…" : "Retry"}
      </button>}
  </div>;
}
