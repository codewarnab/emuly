"use client";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { mutatePhone, phoneCreationOptions } from "@/app/actions/phones";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IdleTimeoutField } from "@/components/settings/idle-timeout-field";
import { usePhoneAction } from "@/components/phone/use-phone-action";
import type { Usage } from "@/lib/usage";
import s from "@/components/console.module.css";

export function PhoneMutation({ id, state }: { id: string; state: string }) {
  const [, action, pending] = usePhoneAction();
  const operation = state === "stopped" || state === "error" || state === "needsyou" ? "start" : "stop";
  return <form action={action} className={s.phoneMutation}>
    <input type="hidden" name="operation" value={operation} />
    <input type="hidden" name="phoneId" value={id} />
    <Button tiny variant="ghost" disabled={pending || state === "stopping" || state === "keeping"}>{state === "keeping" ? "Keeping…" : pending ? "Sending…" : operation === "start" ? "Wake" : state === "stopping" ? "Stopping…" : "Stop"}</Button>
  </form>;
}

export function KeepPhone({ id }: { id: string }) {
  const [, action, pending] = usePhoneAction();
  return <form action={action} className={s.keepPhone}>
    <input type="hidden" name="operation" value="keep" />
    <input type="hidden" name="phoneId" value={id} />
    <Button tiny variant="ghost" disabled={pending} aria-describedby={`keep-cost-${id}`}>{pending ? "Keeping…" : "Keep it"}</Button>
    <span id={`keep-cost-${id}`}>Uses about 3 minutes of your hours.</span>
  </form>;
}

export function RetryBoot({ id }: { id: string }) {
  const [result, action, pending] = useActionState(mutatePhone, { message: "" });
  return <form action={action}>
    <input type="hidden" name="operation" value="retryBoot" />
    <input type="hidden" name="phoneId" value={id} />
    <Button tiny disabled={pending}>{pending ? "Sending…" : "Retry boot"}</Button>
    {result.message && <p role="status">{result.message}</p>}
  </form>;
}

export function NewPhone({ usage }: { usage: Usage }) {
  const running = usage.running.length > 0;
  const [options, setOptions] = useState<Awaited<ReturnType<typeof phoneCreationOptions>> | null>(null);
  const left = Math.max(0, usage.allowance_core_hours - usage.used_core_hours);
  // Every phone uses the 4-core machine (PHONE_MACHINE in lib/github.ts).
  const nextRate = usage.running.reduce((sum, phone) => sum + phone.cores, 4);
  async function show() {
    setOpen(true);
    setOptions(null);
    setOptions(await phoneCreationOptions());
  }
  const [open, setOpen] = useState(false);
  const [result, action, pending] = useActionState(mutatePhone, { message: "" });
  return <>
    <Button onClick={() => { void show(); }}>New phone</Button>
    {open && <Dialog title="New phone" close={() => { if (!pending) setOpen(false); }}>
      {!options ? <NewPhoneSkeleton />
      : options.message ? <div className={s.createForm}>
        <p className={s.createError} role="alert">{options.message}</p>
        <Button onClick={() => { void show(); }}>Try again</Button>
      </div>
      : <form action={action} className={s.createForm}>
        <input type="hidden" name="operation" value="create" />
        <div className={s.specRow} aria-label="Machine">
          <span><b>4</b> cores</span><span><b>16</b> GB RAM</span><span><b>32</b> GB storage</span>
        </div>
        <IdleTimeoutField name="idleTimeoutMin" defaultValue={options.settings.default_idle_min ?? 30} />
        <div className={s.createFoot}>
          <p className={s.createHint} title="Estimated from phonelink phones only. Other codespaces use the same hours. Stopped phones are kept for 30 days.">
            <strong>{(left / nextRate).toFixed(1)} h</strong> left{running ? ` with ${usage.running.length + 1} running` : " this month"}
          </p>
          <Button disabled={pending}>{pending ? "Creating…" : running ? "Start another" : "Create phone"}</Button>
        </div>
        {result.message && <p role="status">{result.message}</p>}
        {result.message && !result.phoneId && <p className={s.createHint}><a href="https://github.com/settings/billing/usage" target="_blank" rel="noreferrer">Check exact usage on GitHub</a>, then try again.</p>}
        {result.phoneId && <Link href={`/app/phones/${encodeURIComponent(result.phoneId)}`}>Open phone</Link>}
      </form>}
    </Dialog>}
  </>;
}

function NewPhoneSkeleton() {
  return <div className={s.createForm} role="status" aria-label="Loading phone options" aria-busy="true">
    <div className={s.specRow} aria-hidden="true">
      <div className={s.newPhoneSkeletonSpec} />
      <div className={s.newPhoneSkeletonSpec} />
      <div className={s.newPhoneSkeletonSpec} />
    </div>
    <div aria-hidden="true">
      <div className={s.newPhoneSkeletonLabel} />
      <div className={s.idleChoices}>
        {Array.from({ length: 6 }, (_, index) => <div className={s.newPhoneSkeletonChoice} key={index} />)}
      </div>
    </div>
    <div className={s.createFoot} aria-hidden="true">
      <div className={s.newPhoneSkeletonLabel} />
      <div className={s.newPhoneSkeletonButton} />
    </div>
  </div>;
}

export function PhoneRefresh() {
  const router = useRouter();
  useEffect(() => {
    let lastRefresh = -Infinity;
    const refresh = () => {
      if (document.hidden || performance.now() - lastRefresh < 1000) return;
      lastRefresh = performance.now();
      router.refresh();
    };
    const timer = setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [router]);
  return null;
}

export function StopAll({ count }: { count: number }) {
  const [, action, pending] = usePhoneAction();
  if (!count) return null;
  return <form action={action}><input type="hidden" name="operation" value="stopAll" />
    <Button variant="ghost" disabled={pending}>{pending ? "Stopping..." : "Stop all running"}</Button>
  </form>;
}
