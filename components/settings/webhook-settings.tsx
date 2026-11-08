"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { Webhook, Delivery } from "@/lib/webhooks/webhooks";
import { WEBHOOK_EVENTS } from "@/lib/webhooks/webhook-event-types";
import { copyText, useToast } from "@/components/ui/ui-provider";
import { Button } from "@/components/ui/button";
import s from "@/components/console.module.css";

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
function urlError(value: string) {
  try { if (new URL(value).protocol === "https:") return ""; } catch { /* Incomplete URL. */ }
  return value ? "Enter an HTTPS URL." : "";
}
type Run = (task: () => Promise<void>) => Promise<void>;
export function WebhookSettings({ initial, recent }: { initial: Webhook[]; recent: Record<string, Delivery[]> }) {
  const [hooks, setHooks] = useState(initial);
  const [message, setMessage] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const notify = useToast();
  async function run(task: () => Promise<void>) {
    setPending(true); setMessage("");
    try { await task(); setHooks(await api("")); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Request failed."); }
    finally { setPending(false); }
  }
  return <div className={s.webhooks}>
    <EndpointForm pending={pending} submit={async (data, reset) => {
      await run(async () => {
        const hook = await api("", "POST", { url: data.get("url"), events: selection(data) });
        setSecret(hook.secret); reset();
      });
    }} />
    <p className={s.webhookMessage} role="status">{message}</p>
    {secret && <div className={s.secretPanel}>
      <code className={s.webhookSecret}>{secret}</code><span>Shown once.</span>
      <Button tiny variant="ghost" onClick={() => void copyText(secret, notify, "Secret copied")}>Copy</Button>
      <Button tiny variant="ghost" onClick={() => setSecret(null)}>Done</Button>
    </div>}
    {hooks.length === 0 && <p>No webhooks yet.</p>}
    {hooks.map(hook => <Endpoint key={hook.id} hook={hook} initialDeliveries={recent[hook.id] ?? []}
      pending={pending} run={run} reveal={setSecret} />)}
  </div>;
}

function EndpointForm({ hook, pending, submit }: { hook?: Webhook; pending: boolean;
  submit: (data: FormData, reset: () => void) => Promise<void> }) {
  const [url, setUrl] = useState(hook?.url ?? "");
  const [generation, setGeneration] = useState(0);
  const id = useId();
  const error = urlError(url);
  return <form className={s.createForm} onSubmit={event => {
    event.preventDefault();
    if (error) return;
    void submit(new FormData(event.currentTarget), () => { setUrl(""); setGeneration(value => value + 1); });
  }}>
    <div className={s.webhookAddRow}>
      <label htmlFor={hook ? id : "webhook-endpoint-url"}>Endpoint URL
        <input id={hook ? id : "webhook-endpoint-url"} name="url" type="url" placeholder="https://example.com/webhooks"
          required value={url} onChange={event => setUrl(event.target.value)} aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined} />
      </label>
      <Button disabled={pending || !!error || !url}>{hook ? "Update" : "Add"}</Button>
    </div>
    {error && <p id={`${id}-error`} className={s.webhookError} role="status">{error}</p>}
    <EventChoices key={generation} events={hook?.events} />
  </form>;
}
function EventChoices({ events = "*" }: { events?: "*" | string[] }) {
  const [selected, setSelected] = useState<string[]>(events === "*" ? [...WEBHOOK_EVENTS] : events);
  return <details className={s.eventDisclosure}><summary>Events: {selected.length === WEBHOOK_EVENTS.length ? "all" : selected.length} ({WEBHOOK_EVENTS.length})</summary>
    <fieldset className={s.webhookEvents}><legend>Events</legend>{WEBHOOK_EVENTS.map(type =>
      <label className={s.eventChip} key={type}><input type="checkbox" name="events" value={type} checked={selected.includes(type)}
        onChange={event => setSelected(values => event.target.checked ? [...values, type] : values.filter(value => value !== type))} /><span>{type}</span></label>)}</fieldset>
  </details>;
}

type TestResult = { state: string; status: number | null; duration_ms: number | null };
function Endpoint({ hook, initialDeliveries, pending, run, reveal }: { hook: Webhook; initialDeliveries: Delivery[]; pending: boolean;
  run: Run; reveal: (value: string) => void }) {
  const [deliveries, setDeliveries] = useState(initialDeliveries);
  const [selected, setSelected] = useState<Delivery | null>(null);
  const [all, setAll] = useState<Delivery[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestResult | string | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const busy = useRef(false);
  const sendRef = useRef<() => void>(() => {});
  async function refresh() {
    const rows: Delivery[] = await api(`/${hook.id}/deliveries`);
    setDeliveries(rows.slice(0, 5));
    if (all !== null) setAll(rows);
    setSelected(value => value ? rows.find(row => row.id === value.id) ?? value : null);
  }
  async function test() {
    if (busy.current || !hook.enabled) return;
    busy.current = true; setSending(true); setResult(null);
    try {
      setResult(await api(`/${hook.id}/test?wait=1`, "POST"));
      // Keep the receiver's result if refreshing the delivery list fails.
      await run(refresh);
    }
    catch (error) { setResult(error instanceof Error ? error.message : "Request failed."); }
    finally { busy.current = false; setSending(false); }
  }
  sendRef.current = () => { void test(); };
  useEffect(() => {
    const listener = (event: Event) => { if ((event as CustomEvent).detail === hook.id) sendRef.current(); };
    window.addEventListener("phonelink-test-webhook", listener);
    return () => window.removeEventListener("phonelink-test-webhook", listener);
  }, [hook.id]);
  const success = typeof result === "object" && result?.state === "ok";
  const status = hook.failing_since ? "failing" : hook.enabled ? "enabled" : "disabled";
  function closeMenu() { if (menu.current) menu.current.open = false; }
  return <section className={s.webhookEndpoint} aria-label={`Webhook ${hook.url}`}>
    <header className={s.webhookHeader}>
      <span className={s.webhookDot} data-state={status} title={status} role="img" aria-label={status} />
      <h2 className={s.webhookUrl} title={hook.url}>{hook.url}</h2>
      <details ref={menu} className={s.webhookMenu}><summary aria-label={`Actions for ${hook.url}`}>…</summary>
        <div className={s.webhookMenuItems}>
          <Button tiny variant="ghost" onClick={() => { closeMenu(); setEditing(value => !value); }}>Edit</Button>
          <Button tiny variant="ghost" disabled={pending} onClick={() => { closeMenu(); void run(async () => {
            const changed = await api(`/${hook.id}`, "PATCH", { roll_secret: true }); reveal(changed.secret);
          }); }}>Roll secret</Button>
          <Button tiny variant="ghost" disabled={pending} onClick={() => { closeMenu(); void run(async () => {
            await api(`/${hook.id}`, "PATCH", { enabled: !hook.enabled });
          }); }}>{hook.enabled ? "Disable" : "Re-enable"}</Button>
          <Button tiny variant="danger" onClick={() => { closeMenu(); setRemoving(true); }}>Remove</Button>
        </div>
      </details>
    </header>
    {editing && <EndpointForm hook={hook} pending={pending} submit={async data => {
      await run(async () => { await api(`/${hook.id}`, "PATCH", { url: data.get("url"), events: selection(data) }); setEditing(false); });
    }} />}
    {removing && <div className={s.inlineConfirm}><span>Remove this webhook?</span>
      <Button tiny variant="danger" disabled={pending} onClick={() => void run(async () => { await api(`/${hook.id}`, "DELETE"); })}>Remove</Button>
      <Button tiny variant="ghost" onClick={() => setRemoving(false)}>Cancel</Button>
    </div>}
    <div className={s.webhookTestRow}>
      <Button tiny disabled={pending || sending || !hook.enabled} onClick={() => void test()}>{sending ? "Sending…" : "Send test"}</Button>
      <span className={s.webhookResult} data-ok={success} aria-live="polite">{result && (typeof result === "string" ? `Failed · ${result}`
        : success ? `${result.status} · ${result.duration_ms} ms` : `Failed · ${result.status ? `HTTP ${result.status}` : "Network error or timeout"}`)}</span>
    </div>
    <div className={s.deliveryDots} aria-label="Recent deliveries">
      {deliveries.map(delivery => <button type="button" key={delivery.id} className={s.deliveryDot}
        data-state={delivery.state === "ok" ? "ok" : delivery.attempt > 0 ? "failed" : "pending"}
        title={`${delivery.type} · ${delivery.status ?? delivery.state} · ${delivery.attempted_at ?? delivery.created_at}`}
        aria-label={`${delivery.type} · ${delivery.status ?? delivery.state} · ${delivery.attempted_at ?? delivery.created_at}`}
        aria-expanded={selected?.id === delivery.id} onClick={() => setSelected(value => value?.id === delivery.id ? null : delivery)} />)}
      {!deliveries.length && <small>No deliveries yet.</small>}
      <Button tiny variant="ghost" onClick={() => void run(async () => { setAll(all === null ? await api(`/${hook.id}/deliveries`) : null); })}>{all === null ? "View all" : "Close all"}</Button>
    </div>
    {selected && <div className={s.deliveryPanel}>
      <dl><dt>Time</dt><dd>{selected.attempted_at ?? selected.created_at}</dd><dt>Event</dt><dd>{selected.type}</dd>
        <dt>HTTP status</dt><dd>{selected.status ?? "—"}</dd><dt>Duration</dt><dd>{selected.duration_ms === null ? "—" : `${selected.duration_ms} ms`}</dd>
        <dt>Attempts</dt><dd>{selected.attempt}</dd></dl>
      <Button tiny variant="ghost" disabled={pending} onClick={() => void run(async () => {
        await api(`/${hook.id}/deliveries/${selected.id}/resend`, "POST"); await refresh();
      })}>Resend</Button>
    </div>}
    {all !== null && <div className={s.webhookLog}><table><caption>Last 50 deliveries</caption>
      <thead><tr><th>Time (UTC)</th><th>Event</th><th>State</th><th>HTTP</th><th>Duration</th><th>Attempts</th><th>Action</th></tr></thead>
      <tbody>{all.map(delivery => <tr key={delivery.id}><td>{delivery.attempted_at ?? delivery.created_at}</td><td>{delivery.type}</td>
        <td>{delivery.state}</td><td>{delivery.status ?? "—"}</td><td>{delivery.duration_ms === null ? "—" : `${delivery.duration_ms} ms`}</td>
        <td>{delivery.attempt}</td><td><Button tiny variant="ghost" disabled={pending} onClick={() => void run(async () => {
          await api(`/${hook.id}/deliveries/${delivery.id}/resend`, "POST"); await refresh();
        })}>Resend</Button></td></tr>)}</tbody></table>{!all.length && <p>No deliveries yet.</p>}</div>}
  </section>;
}
