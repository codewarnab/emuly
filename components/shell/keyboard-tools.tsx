"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AGENT_PROMPT } from "@/lib/agent-prompt";
import { filterCommands, PHONE_TABS, phoneTabHref, SETTINGS_TABS, SETTINGS_KEYS } from "@/lib/shared/keyboard";
import { useSettingsControls } from "@/components/settings/settings-provider";
import type { Webhook } from "@/lib/webhooks/webhooks";
import { copyText, useToast } from "@/components/ui/ui-provider";
import { cycleTheme, setTheme, type Theme } from "@/components/shell/theme-toggle";
import { useShortcuts } from "@/components/shell/use-shortcuts";
import { Dialog } from "@/components/ui/dialog";
import s from "@/components/interaction.module.css";

export const CONTROL_REASON = "Phone controls are not connected yet.";
type PhoneChoice = { id: string; name: string; stream?: string; adb?: string };
// `more` commands stay hidden until you type, so the menu opens short.
type Command = { id: string; label: string; hint: string; run: () => void; reason?: string; keywords?: string; more?: boolean };
export function CommandHint() {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  return <button className={s.hint} aria-label="Open command menu" onClick={() => window.dispatchEvent(new Event("phonelink-command"))}>{mac ? "⌘K" : "Ctrl K"}</button>;
}
export function KeyboardTools({ phones }: { phones?: PhoneChoice[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const settings = useSettingsControls();
  const onSettings = pathname.startsWith("/app/settings/");
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const notify = useToast();
  const [sheet, setSheet] = useState<"commands" | "shortcuts" | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const current = phones?.find(phone => pathname === `/app/phones/${phone.id}`);
  const unavailable = useCallback(() => notify(CONTROL_REASON), [notify]);
  const tab = useCallback((index: number) => {
    if (current) router.push(phoneTabHref(current.id, PHONE_TABS[index]!), { scroll: false });
  }, [current, router]);
  const copyStream = useCallback(() => {
    if (current?.stream) void copyText(current.stream, notify, "Stream URL copied");
    else notify("Stream URL is not available until the phone connects.");
  }, [current, notify]);
  const theme = useCallback((choice?: Theme) => {
    const value = choice ?? cycleTheme();
    if (choice) setTheme(choice);
    notify(`Theme: ${value}.`);
  }, [notify]);
  useEffect(() => {
    const open = () => setSheet(value => value === "commands" ? null : "commands");
    window.addEventListener("phonelink-command", open);
    return () => window.removeEventListener("phonelink-command", open);
  }, []);
  useEffect(() => {
    if (sheet !== "commands" || !onSettings) return;
    const controller = new AbortController();
    void fetch("/v1/webhooks", { cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("Could not load webhook commands."); return response.json(); })
      .then(setWebhooks).catch(error => { if (!controller.signal.aborted) notify(error.message); });
    return () => controller.abort();
  }, [sheet, onSettings, notify]);
  const handle = useCallback((key: string) => {
    if (key === "command") { setSheet(value => value === "commands" ? null : "commands"); return; }
    if (key === "?") { setSheet("shortcuts"); return; }
    if (key === "t") { theme(); return; }
    if (!phones) return;
    const settingTab = SETTINGS_TABS.find(item => item.shortcut === key || (onSettings && item.key === key));
    if (settingTab) { router.push(settingTab.href); return; }
    if (onSettings && key === SETTINGS_KEYS.endpoint && pathname === "/app/settings/webhooks") {
      document.getElementById("webhook-endpoint-url")?.focus(); return;
    }
    if (key === "g p") router.push("/app");
    else if (key.startsWith("g ")) {
      const phone = phones[Number(key.slice(2)) - 1];
      if (phone) router.push(`/app/phones/${encodeURIComponent(phone.id)}`);
      else notify("There is no phone in that slot yet. Copy the setup prompt to get one.");
    } else if (current) {
      if (/^[1-4]$/.test(key)) tab(Number(key) - 1);
      if (key === "w" || key === "s") unavailable();
      if (key === "c") copyStream();
    }
  }, [phones, current, router, notify, theme, tab, unavailable, copyStream, onSettings, pathname]);
  useShortcuts(handle, sheet !== null);
  const commands: Command[] = phones ? [
    { id: "phones", label: "Go to Phones", hint: "g p", run: () => router.push("/app") },
    ...SETTINGS_TABS.map(item => ({ id: `settings-${item.key}`, label: `Go to Settings: ${item.label}`, hint: item.shortcut, run: () => router.push(item.href) })),
    ...phones.map((phone, index) => ({ id: phone.id, label: `Open ${phone.name}`, hint: index < 9 ? `g ${index + 1}` : "", more: index >= 3, run: () => router.push(`/app/phones/${encodeURIComponent(phone.id)}`) })),
    ...(current ? [
      { id: "wake", label: "Wake current phone", hint: "w", run: unavailable, reason: CONTROL_REASON },
      { id: "stop", label: "Stop current phone", hint: "s", run: unavailable, reason: CONTROL_REASON },
      ...PHONE_TABS.map((value, index) => ({ id: value, label: `Go to ${["Agent log", "Apps", "Backups", "Danger"][index]} tab`, hint: `${index + 1}`, run: () => tab(index) })),
      { id: "stream", label: "Copy stream URL", hint: "c", run: copyStream, reason: current.stream ? undefined : "Available when the phone connects." },
      { id: "adb", label: "Copy adb address", hint: "", run: () => { if (current.adb) void copyText(current.adb, notify, "adb address copied"); }, reason: current.adb ? undefined : "Available when the phone connects." },
    ] : []),
  ] : [
    { id: "prompt", label: "Copy prompt", hint: "", run: () => { void copyText(AGENT_PROMPT, notify, "Prompt copied"); } },
    { id: "signin", label: "Sign in", hint: "", run: () => router.push("/login") },
    { id: "theme", label: "Toggle theme", hint: "t", run: () => theme() },
  ];
  if (phones) {
    if (settings) {
      commands.push({ id: "auto-stop", label: `Auto-stop · ${settings.values.autoStop ? "On" : "Off"}`, keywords: "toggle stop hours", hint: SETTINGS_KEYS.autoStop,
        run: () => settings.save("autoStop", !settings.values.autoStop), reason: settings.pending ? "Saving…" : undefined });
      commands.push({ id: "auto-keep", label: `Keep stopped phones · ${settings.values.autoKeep ? "On" : "Off"}`, keywords: "toggle retention", hint: SETTINGS_KEYS.autoKeep,
        run: () => settings.save("autoKeep", !settings.values.autoKeep), reason: settings.pending ? "Saving…" : undefined });
      for (const hook of webhooks.filter(hook => hook.enabled)) commands.push({ id: `test-${hook.id}`,
        label: `Send test to ${hook.url}`, hint: SETTINGS_KEYS.test, run: () => {
          window.dispatchEvent(new CustomEvent("phonelink-test-webhook", { detail: hook.id }));
          if (pathname !== "/app/settings/webhooks") {
            void fetch(`/v1/webhooks/${encodeURIComponent(hook.id)}/test?wait=1`, { method: "POST" })
              .then(async response => {
                const result = await response.json();
                if (!response.ok) throw new Error(result.message ?? "Test failed.");
                notify(result.state === "ok" ? `${result.status} · ${result.duration_ms} ms` : `Failed · ${result.status ?? "Network error or timeout"}`);
              }).catch(error => notify(error.message));
          }
        } });
    }
    commands.push({ id: "theme", label: "Change theme", hint: "t", keywords: "light dark system", more: true, run: () => theme() });
    commands.push({ id: "signout", label: "Sign out", hint: "", keywords: "log out", more: true, run: () => form.current?.requestSubmit() });
  }
  commands.push({ id: "shortcuts", label: "Keyboard shortcuts", hint: "?", more: true, run: () => setSheet("shortcuts") });
  return <>
    {phones && <form hidden ref={form} action="/auth/logout" method="post" />}
    {sheet === "commands" && <CommandMenu commands={commands} close={() => setSheet(null)} />}
    {sheet === "shortcuts" && <Dialog title="Keyboard shortcuts" close={() => setSheet(null)}><div className={s.shortcuts}>
      <h3>Everywhere</h3><p><span>Command menu</span><kbd>⌘K / Ctrl K</kbd></p><p><span>Show shortcuts</span><kbd>?</kbd></p><p><span>Toggle dark mode</span><kbd>t</kbd></p><p><span>Close menu or dialog</span><kbd>Esc</kbd></p>
      {phones && <><h3>Navigation</h3><p><span>Go to Phones</span><kbd>g then p</kbd></p><p><span>Open phones 1–9</span><kbd>g then 1–9</kbd></p>
      {SETTINGS_TABS.map(item => <p key={item.key}><span>Go to Settings: {item.label}</span><kbd>{item.shortcut}</kbd></p>)}
      <h3>In Settings</h3><p><span>Settings tabs</span><kbd>{SETTINGS_TABS.map(item => item.key).join(" / ")}</kbd></p>
      <p><span>Focus Endpoint URL on Webhooks</span><kbd>{SETTINGS_KEYS.endpoint}</kbd></p>
      <h3>On a phone</h3><p><span>Agent log / Apps / Backups / Danger tab</span><kbd>1 / 2 / 3 / 4</kbd></p><p><span>Wake / Stop (unavailable)</span><kbd>w / s</kbd></p><p><span>Copy stream URL</span><kbd>c</kbd></p></>}
      <p className={s.help}>Shortcuts pause while you type. Deleting a phone has no shortcut.</p>
    </div></Dialog>}
  </>;
}
function CommandMenu({ commands, close }: { commands: Command[]; close: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const items = query.trim() ? filterCommands(commands, query) : commands.filter(item => !item.more);
  const selected = items[Math.min(index, Math.max(0, items.length - 1))];
  const notify = useToast();
  function run(item: Command) {
    if (item.reason) { notify(item.reason); return; }
    close(); item.run();
  }
  useEffect(() => { if (selected) document.getElementById(`command-${selected.id}`)?.scrollIntoView({ block: "nearest" }); }, [selected]);
  return <Dialog title="Command menu" close={close}>
    <input className={s.search} autoFocus aria-label="Search commands" role="combobox" aria-expanded="true" aria-controls="command-options" aria-autocomplete="list" aria-activedescendant={selected ? `command-${selected.id}` : undefined} placeholder="Type a command or search…" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex(value => (value + (event.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length)); }
      if (event.key === "Enter" && selected) { event.preventDefault(); run(selected); }
    }} />
    <div id="command-options" role="listbox" aria-label="Commands" className={s.commands}>
      {items.map((item, i) => <button type="button" tabIndex={-1} role="option" aria-selected={item === selected} aria-disabled={!!item.reason} aria-describedby={item.reason ? `reason-${item.id}` : undefined} id={`command-${item.id}`} key={item.id} className={s.command} onMouseMove={() => setIndex(i)} onClick={() => run(item)}><span>{item.label}{item.reason && <small id={`reason-${item.id}`}>{item.reason}</small>}</span>{item.hint && <kbd>{item.hint}</kbd>}</button>)}
      {!items.length && <p className={s.help}>No commands match. Try a phone name or “theme”.</p>}
    </div><p className={s.help}>Type to see more · ↑ ↓ · Enter · Esc</p>
  </Dialog>;
}
