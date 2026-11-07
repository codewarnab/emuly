"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AGENT_PROMPT } from "../lib/agent-prompt";
import { filterCommands, PHONE_TABS, phoneTabHref } from "../lib/keyboard";
import { copyText, useToast } from "./ui-provider";
import { cycleTheme, setTheme, type Theme } from "./theme-toggle";
import { useShortcuts } from "./use-shortcuts";
import { Dialog } from "./dialog";
import s from "./interaction.module.css";

export const CONTROL_REASON = "Phone controls are not connected yet.";
type PhoneChoice = { id: string; name: string; stream?: string; adb?: string };
type Command = { id: string; label: string; hint: string; run: () => void; reason?: string; keywords?: string };
export function CommandHint() {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  return <button className={s.hint} aria-label="Open command menu" onClick={() => window.dispatchEvent(new Event("phonelink-command"))}>{mac ? "⌘K" : "Ctrl K"}</button>;
}
export function KeyboardTools({ phones }: { phones?: PhoneChoice[] }) {
  const router = useRouter();
  const pathname = usePathname();
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
  const handle = useCallback((key: string) => {
    if (key === "command") { setSheet(value => value === "commands" ? null : "commands"); return; }
    if (key === "?") { setSheet("shortcuts"); return; }
    if (key === "t") { theme(); return; }
    if (!phones) return;
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
  }, [phones, current, router, notify, theme, tab, unavailable, copyStream]);
  useShortcuts(handle, sheet !== null);
  const commands: Command[] = phones ? [
    { id: "phones", label: "Go to Phones", hint: "g p", run: () => router.push("/app") },
    ...phones.map((phone, index) => ({ id: phone.id, label: `Open ${phone.name}`, hint: index < 9 ? `g ${index + 1}` : "Enter", run: () => router.push(`/app/phones/${encodeURIComponent(phone.id)}`) })),
    ...(current ? [
      { id: "wake", label: "Wake current phone", hint: "w", run: unavailable, reason: CONTROL_REASON },
      { id: "stop", label: "Stop current phone", hint: "s", run: unavailable, reason: CONTROL_REASON },
      ...PHONE_TABS.map((value, index) => ({ id: value, label: `Go to ${["Agent log", "Apps", "Backups", "Danger"][index]} tab`, hint: `${index + 1}`, run: () => tab(index) })),
      { id: "stream", label: "Copy stream URL", hint: "c", run: copyStream, reason: current.stream ? undefined : "Available when the phone connects." },
      { id: "adb", label: "Copy adb address", hint: "Enter", run: () => { if (current.adb) void copyText(current.adb, notify, "adb address copied"); }, reason: current.adb ? undefined : "Available when the phone connects." },
    ] : []),
  ] : [
    { id: "prompt", label: "Copy prompt", hint: "Enter", run: () => { void copyText(AGENT_PROMPT, notify, "Prompt copied"); } },
    { id: "signin", label: "Sign in", hint: "Enter", run: () => router.push("/login") },
    { id: "theme", label: "Toggle theme", hint: "t", run: () => theme() },
  ];
  if (phones) {
    for (const value of ["light", "dark", "system"] as Theme[]) commands.push({ id: value, label: `Theme: ${value[0]!.toUpperCase()}${value.slice(1)}`, hint: "t toggles", run: () => theme(value) });
    commands.push({ id: "signout", label: "Sign out", hint: "Enter", run: () => form.current?.requestSubmit() });
  }
  commands.push({ id: "shortcuts", label: "Show keyboard shortcuts", hint: "?", run: () => setSheet("shortcuts") });
  return <>
    {phones && <form hidden ref={form} action="/auth/logout" method="post" />}
    {sheet === "commands" && <CommandMenu commands={commands} close={() => setSheet(null)} />}
    {sheet === "shortcuts" && <Dialog title="Keyboard shortcuts" close={() => setSheet(null)}><div className={s.shortcuts}>
      <h3>Everywhere</h3><p><span>Command menu</span><kbd>⌘K / Ctrl K</kbd></p><p><span>Show shortcuts</span><kbd>?</kbd></p><p><span>Toggle dark mode</span><kbd>t</kbd></p><p><span>Close menu or dialog</span><kbd>Esc</kbd></p>
      {phones && <><h3>Navigation</h3><p><span>Go to Phones</span><kbd>g then p</kbd></p><p><span>Open phones 1–9</span><kbd>g then 1–9</kbd></p>
      <h3>On a phone</h3><p><span>Agent log / Apps / Backups / Danger tab</span><kbd>1 / 2 / 3 / 4</kbd></p><p><span>Wake / Stop (unavailable)</span><kbd>w / s</kbd></p><p><span>Copy stream URL</span><kbd>c</kbd></p></>}
      <p className={s.help}>Shortcuts pause while you type. Deleting a phone has no shortcut.</p>
    </div></Dialog>}
  </>;
}
function CommandMenu({ commands, close }: { commands: Command[]; close: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const items = filterCommands(commands, query);
  const selected = items[Math.min(index, Math.max(0, items.length - 1))];
  const notify = useToast();
  function run(item: Command) {
    if (item.reason) { notify(item.reason); return; }
    close(); item.run();
  }
  useEffect(() => { if (selected) document.getElementById(`command-${selected.id}`)?.scrollIntoView({ block: "nearest" }); }, [selected]);
  return <Dialog title="Command menu" close={close}>
    <input className={s.search} autoFocus aria-label="Search commands" role="combobox" aria-expanded="true" aria-controls="command-options" aria-autocomplete="list" aria-activedescendant={selected ? `command-${selected.id}` : undefined} placeholder="Find a command…" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex(value => (value + (event.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length)); }
      if (event.key === "Enter" && selected) { event.preventDefault(); run(selected); }
    }} />
    <div id="command-options" role="listbox" aria-label="Commands" className={s.commands}>
      {items.map((item, i) => <button type="button" tabIndex={-1} role="option" aria-selected={item === selected} aria-disabled={!!item.reason} aria-describedby={item.reason ? `reason-${item.id}` : undefined} id={`command-${item.id}`} key={item.id} className={s.command} onMouseMove={() => setIndex(i)} onClick={() => run(item)}><span>{item.label}{item.reason && <small id={`reason-${item.id}`}>{item.reason}</small>}</span><kbd>{item.hint}</kbd></button>)}
      {!items.length && <p className={s.help}>No commands match. Try a phone name or “theme”.</p>}
    </div><p className={s.help}>↑ ↓ to choose. Enter to run. Esc to close.</p>
  </Dialog>;
}
