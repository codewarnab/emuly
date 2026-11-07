"use client";
import { useState } from "react";
import type { Webhook, Delivery } from "../lib/webhooks";
import { WEBHOOK_EVENTS } from "../lib/webhook-event-types";
import { Button } from "./button";
import s from "./console.module.css";

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/v1/webhooks${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? "The webhook request failed. Try again.");
  return result;
}

function selection(data: FormData) {
  const events = data.getAll("events");
  return events.length === WEBHOOK_EVENTS.length ? "*" : events;
}

export function WebhookSettings({ initial }: { initial: Webhook[] }) {
  const [hooks, setHooks] = useState(initial);
  const [message, setMessage] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function run(task: () => Promise<void>) {
    setPending(true); setMessage(""); setSecret(null);
    try { await task(); setHooks(await api("")); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Request failed."); }
    finally { setPending(false); }
  }
  return <div className={s.webhooks}>
    <form className={s.createForm} onSubmit={event => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
      void run(async () => { const hook = await api("", "POST", { url: data.get("url"), events: selection(data) });
        setSecret(hook.secret); setMessage("Webhook added."); form.reset(); });
    }}>
      <label>Endpoint URL<input name="url" type="url" placeholder="https://example.com/webhooks" required /></label>
      <EventChoices />
      <Button disabled={pending}>Add webhook</Button>
    </form>
    {message && <p role="status">{message}</p>}
    {secret && <div className={s.budgetWarning} role="status"><p>Copy this signing secret now. It appears only once.</p>
      <code className={s.webhookSecret}>{secret}</code><Button tiny variant="ghost" onClick={() => setSecret(null)}>Hide secret</Button></div>}
    {hooks.length === 0 && <p>No webhook endpoints yet.</p>}
    {hooks.map(hook => <Endpoint key={hook.id} hook={hook} pending={pending} run={run} reveal={setSecret} />)}
  </div>;
}

function EventChoices({ events = "*" }: { events?: "*" | string[] }) {
  return <fieldset className={s.webhookEvents}><legend>Events</legend>{WEBHOOK_EVENTS.map(type =>
    <label className={s.checkboxLabel} key={type}><input type="checkbox" name="events" value={type}
      defaultChecked={events === "*" || events.includes(type)} /><span>{type}</span></label>)}</fieldset>;
}

function Endpoint({ hook, pending, run, reveal }: { hook: Webhook; pending: boolean;
  run: (task: () => Promise<void>) => Promise<void>; reveal: (value: string) => void }) {
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  return <section className={s.webhookEndpoint} aria-label={`Webhook ${hook.url}`}>
    <h2 className={s.webhookUrl}>{hook.url}</h2>
    <p>{hook.enabled ? "Enabled" : "Disabled"}. Signing secret: ••••••••</p>
    {!hook.enabled && hook.failing_since && <p className={s.budgetWarning} role="status">Disabled after 3 days of only failures. Fix the receiver, then re-enable this webhook.</p>}
    <details><summary>Edit URL and events</summary><form className={s.createForm} onSubmit={event => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      void run(async () => { await api(`/${hook.id}`, "PATCH", { url: data.get("url"), events: selection(data) }); });
    }}><label>Endpoint URL<input type="url" name="url" defaultValue={hook.url} required /></label>
      <EventChoices events={hook.events} /><Button disabled={pending}>Save webhook</Button></form></details>
    <div className={s.acts}>
      <Button tiny disabled={pending || !hook.enabled} title={hook.enabled ? "Queue a test event" : "Re-enable this webhook before testing it"}
        onClick={() => void run(async () => { await api(`/${hook.id}/test`, "POST"); })}>Test</Button>
      <Button tiny variant="ghost" disabled={pending} onClick={() => void run(async () => {
        const result = await api(`/${hook.id}`, "PATCH", { roll_secret: true }); reveal(result.secret);
      })}>Roll secret</Button>
      <Button tiny variant="ghost" disabled={pending} onClick={() => void run(async () => {
        await api(`/${hook.id}`, "PATCH", { enabled: !hook.enabled });
      })}>{hook.enabled ? "Disable" : "Re-enable"}</Button>
      <Button tiny variant="danger" disabled={pending} onClick={() => void run(async () => { await api(`/${hook.id}`, "DELETE"); })}>Remove</Button>
      <Button tiny variant="ghost" disabled={pending} onClick={() => void run(async () => {
        setDeliveries(await api(`/${hook.id}/deliveries`));
      })}>Refresh deliveries</Button>
    </div>
    <p>Delivery runs every 60 seconds. Test and resend queue a delivery. Disabled endpoints keep their queue.</p>
    {deliveries !== null && <div className={s.webhookLog}><table><caption>Last 50 deliveries</caption>
      <thead><tr><th>Time (UTC)</th><th>Event</th><th>State</th><th>HTTP</th><th>Duration</th><th>Attempts</th><th>Action</th></tr></thead>
      <tbody>{deliveries.map(delivery => <tr key={delivery.id}><td>{delivery.attempted_at ?? delivery.created_at}</td><td>{delivery.type}</td>
        <td>{delivery.state}</td><td>{delivery.status ?? "—"}</td><td>{delivery.duration_ms === null ? "—" : `${delivery.duration_ms} ms`}</td>
        <td>{delivery.attempt}</td><td><Button tiny variant="ghost" disabled={pending} onClick={() => void run(async () => {
          await api(`/${hook.id}/deliveries/${delivery.id}/resend`, "POST"); setDeliveries(await api(`/${hook.id}/deliveries`));
        })}>Resend</Button></td></tr>)}</tbody></table>{!deliveries.length && <p>No deliveries yet.</p>}</div>}
  </section>;
}
