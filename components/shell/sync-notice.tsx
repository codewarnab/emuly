"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SyncError } from "@/lib/sync-error";
import { Button } from "@/components/ui/button";
import s from "@/components/console.module.css";

export function SyncNotice({ error }: { error: SyncError }) {
  const router = useRouter();
  const delay = Math.max(0, Math.ceil(error.retryAfter ?? 60));
  const [remaining, setRemaining] = useState(delay);
  const retried = useRef(false);

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
        router.refresh();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [error.kind, delay, router]);

  function retry() {
    retried.current = true;
    setRemaining(0);
    router.refresh();
  }

  return <div role="status" className={s.hoursBanner}>
    <span>{error.message}</span>{" "}
    {error.kind === "signin" ? <a className={`${s.btn} ${s.btnTiny} ${s.btnGhost}`} href="/auth/start">Reconnect</a>
      : error.kind === "quota" ? <a className={`${s.btn} ${s.btnTiny} ${s.btnGhost}`}
        href="https://github.com/settings/billing/usage" target="_blank" rel="noreferrer">Open GitHub billing</a>
      : <Button type="button" tiny variant="ghost" onClick={retry}>Retry</Button>}
    {error.kind === "busy" && remaining > 0 && <span> Retrying in {remaining}s</span>}
  </div>;
}
