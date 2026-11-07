"use client";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { mutatePhone, phoneCreationOptions } from "../app/actions/phones";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { useToast } from "./ui-provider";
import type { Usage } from "../lib/usage";
import s from "./console.module.css";

export function PhoneMutation({ id, state }: { id: string; state: string }) {
  const [result, action, pending] = useActionState(mutatePhone, { message: "" });
  const notify = useToast();
  useEffect(() => { if (result.message) notify(result.message); }, [result, notify]);
  const operation = state === "stopped" || state === "error" || state === "needsyou" ? "start" : "stop";
  return <form action={action} className={s.phoneMutation}>
    <input type="hidden" name="operation" value={operation} />
    <input type="hidden" name="phoneId" value={id} />
    <Button tiny variant="ghost" disabled={pending || state === "stopping" || state === "keeping"}>{state === "keeping" ? "Keeping…" : pending ? "Sending…" : operation === "start" ? "Wake" : state === "stopping" ? "Stopping…" : "Stop"}</Button>
  </form>;
}

export function KeepPhone({ id }: { id: string }) {
  const [result, action, pending] = useActionState(mutatePhone, { message: "" });
  const notify = useToast();
  useEffect(() => { if (result.message) notify(result.message); }, [result, notify]);
  return <form action={action} className={s.keepPhone}>
    <input type="hidden" name="operation" value="keep" />
    <input type="hidden" name="phoneId" value={id} />
    <Button tiny variant="ghost" disabled={pending} aria-describedby={`keep-cost-${id}`}>{pending ? "Keeping…" : "Keep it"}</Button>
    <span id={`keep-cost-${id}`}>Uses about 3 minutes of your hours.</span>
  </form>;
}

export function NewPhone({ usage }: { usage: Usage }) {
  const running = usage.running.length > 0;
  const [options, setOptions] = useState<Awaited<ReturnType<typeof phoneCreationOptions>> | null>(null);
  const [machine, setMachine] = useState("");
  const selected = options?.machines.find(item => item.name === machine);
  const left = Math.max(0, usage.allowance_core_hours - usage.used_core_hours);
  const cores = selected?.cpus ?? 4;
  const nextRate = usage.running.reduce((sum, phone) => sum + phone.cores, cores);
  async function show() {
    setOpen(true);
    setOptions(null);
    const choices = await phoneCreationOptions();
    setOptions(choices);
    setMachine(choices.machines.find(item => item.name === choices.settings.default_machine)?.name
      ?? choices.machines.find(item => item.cpus === 4)?.name ?? choices.machines[0]?.name ?? "");
  }
  const [open, setOpen] = useState(false);
  const [result, action, pending] = useActionState(mutatePhone, { message: "" });
  return <>
    <Button onClick={() => { void show(); }}>New phone</Button>
    {open && <Dialog title="New phone" close={() => { if (!pending) setOpen(false); }}>
      <form action={action} className={s.createForm}>
        <input type="hidden" name="operation" value="create" />
        <p>Your phone runs in a new GitHub Codespace in your account.</p>
        <label>Machine<select name="machine" value={machine} onChange={event => setMachine(event.target.value)} disabled={!options?.machines.length}>
          {!options && <option value="">Loading available machines...</option>}
          {options?.machines.map(item => <option key={item.name} value={item.name}>{item.cpus}-core: {item.cpus === 2 ? "lasts longer" : item.cpus === 4 ? "faster boot" : item.display_name}</option>)}
        </select></label>
        <label>Stop after idle<select key={options?.settings.default_idle_min ?? "loading"} name="idleTimeoutMin" defaultValue={String(options?.settings.default_idle_min ?? 30)}>
          <option value="30">30 minutes</option><option value="240">4 hours</option>
        </select></label>
        <p>You have about {(left / cores).toFixed(1)} h left this month on this machine. With {usage.running.length + 1} phones running that is about {(left / nextRate).toFixed(1)} h.</p>
        <p>Estimated from phonelink phones only. Your other codespaces use the same hours.</p>
        {running && <p>Running phones share your hours, so each extra phone uses them faster.</p>}
        {options?.message && <p role="status">{options.message}</p>}
        <p>Stopping keeps the codespace. New phones have 30 days of retention after stopping.</p>
        <Button disabled={pending || !selected}>{pending ? "Creating…" : running ? "Start another phone" : "Create phone"}</Button>
        {result.message && <p role="status">{result.message}</p>}
        {result.message && !result.phoneId && <p><a href="https://github.com/settings/billing/usage" target="_blank" rel="noreferrer">Check exact usage on GitHub</a>, then try again.</p>}
        {result.phoneId && <Link href={`/app/phones/${encodeURIComponent(result.phoneId)}`}>Open phone</Link>}
      </form>
    </Dialog>}
  </>;
}

/** Reconcile asynchronous GitHub changes while this page is visible. */
export function PhoneRefresh() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}

export function StopAll({ count }: { count: number }) {
  const [result, action, pending] = useActionState(mutatePhone, { message: "" });
  const notify = useToast();
  useEffect(() => { if (result.message) notify(result.message); }, [result, notify]);
  if (!count) return null;
  return <form action={action}><input type="hidden" name="operation" value="stopAll" />
    <Button variant="ghost" disabled={pending}>{pending ? "Stopping..." : "Stop all running"}</Button>
  </form>;
}
