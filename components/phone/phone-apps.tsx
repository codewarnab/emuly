"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { APK_CHUNK_BYTES, APK_MAX_BYTES, installFinished, type AppInstall, type InstalledApp } from "@/lib/phone-apps-contract";
import s from "@/components/phone/phone-apps.module.css";

const stages: Record<string, string> = { uploading: "Uploading APK", downloading: "Downloading APK", validating: "Checking APK",
  installing: "Installing app", succeeded: "App installed", failed: "Installation failed", cancelled: "Installation cancelled",
  expired: "Installation expired", interrupted: "Installation needs verification" };
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export function PhoneApps({ id, ready }: { id: string; ready: boolean }) {
  const base = `/v1/phones/${encodeURIComponent(id)}`;
  const [apps, setApps] = useState<InstalledApp[] | null>(null);
  const [operation, setOperation] = useState<AppInstall | null>(null);
  const [error, setError] = useState("");
  const [inventoryError, setInventoryError] = useState("");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [opening, setOpening] = useState("");
  const [notice, setNotice] = useState("");
  const [needsUpdate, setNeedsUpdate] = useState(false);
  const [updating, setUpdating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const transferRunning = useRef(false);
  const pending = useRef<{ key: string; file?: File; url?: string; id?: string } | null>(null);
  const alive = useRef(true);
  const active = operation !== null && !installFinished(operation.stage);

  const api = useCallback(async (path: string, options: RequestInit = {}) => {
    const response = await fetch(`${base}/${path}`, { ...options, cache: "no-store", signal: options.signal ?? AbortSignal.timeout(95_000) });
    const result = await response.json();
    if (!response.ok) {
      if (result.errorCode === "runner_update_required") setNeedsUpdate(true);
      throw new Error(result.error ?? "Phone request failed.");
    }
    return result;
  }, [base]);
  const json = (value: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

  const refresh = useCallback(async () => {
    if (!ready) return;
    try {
      const result = await api("apps");
      if (alive.current) { setApps(result.apps); setInventoryError(""); }
    } catch (cause) { if (alive.current) setInventoryError(cause instanceof Error ? cause.message : "Could not load apps."); }
  }, [api, ready]);
  const refreshOperation = useCallback(async () => {
    if (!ready) return;
    try {
      const result = await api("app-installs");
      const latest: AppInstall | null = result.operations[0] ?? null;
      if (alive.current && !transferRunning.current) {
        setOperation(latest);
        setError("");
        if (latest && installFinished(latest.stage)) void refresh();
      }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "Status unavailable."); }
  }, [api, ready, refresh]);

  useEffect(() => {
    alive.current = true;
    void refresh(); void refreshOperation();
    return () => { alive.current = false; controller.current?.abort(); };
  }, [refresh, refreshOperation]);
  useEffect(() => {
    if (!active || !ready) return;
    let polling = false;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible" || transferRunning.current || polling) return;
      polling = true;
      void refreshOperation().finally(() => { polling = false; });
    }, 1500);
    return () => clearInterval(timer);
  }, [active, ready, refreshOperation]);

  async function upload(file: File, initial: AppInstall, signal: AbortSignal) {
    let current = initial;
    while (current.stage === "uploading" && current.bytesReceived < file.size) {
      const offset = current.bytesReceived;
      const bytes = await file.slice(offset, offset + APK_CHUNK_BYTES).arrayBuffer();
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
      let acknowledged = false;
      for (let attempt = 0; attempt < 3 && !acknowledged; attempt++) {
        try {
          current = await api(`app-installs/${current.id}/content`, { method: "PUT", body: bytes, signal,
            headers: { "content-type": "application/octet-stream", "x-upload-offset": String(offset), "x-chunk-sha256": digest } });
          acknowledged = true;
        } catch (cause) {
          signal.throwIfAborted();
          // A missing acknowledgement does not prove the write failed.
          current = await api(`app-installs/${current.id}`, { signal });
          if (current.bytesReceived === offset + bytes.byteLength || current.stage !== "uploading") acknowledged = true;
          else if (attempt === 2) throw cause;
        }
      }
      if (alive.current) setOperation(current);
    }
    if (current.stage === "uploading") current = await api(`app-installs/${current.id}/complete`, { method: "POST", signal });
    if (alive.current) setOperation(current);
  }
  async function install(file?: File, retry = false) {
    if (!ready || busy) return;
    setError(""); setNotice("");
    if (!retry) {
      if (active) { setError("An installation is already active. Refresh its status first."); return; }
      if (file && (!/\.apk$/i.test(file.name) || file.size < 1 || file.size > APK_MAX_BYTES)) {
        setError("Choose one standalone .apk file up to 250 MiB."); return;
      }
      pending.current = file ? { key: crypto.randomUUID(), file } : { key: crypto.randomUUID(), url: url.trim() };
    }
    const request = pending.current;
    if (!request) return;
    setBusy(true); transferRunning.current = true;
    const abort = new AbortController(); controller.current = abort;
    try {
      let result: AppInstall;
      if (request.id) result = await api(`app-installs/${request.id}`, { signal: abort.signal });
      else {
        result = await api("app-installs", { ...json(request.file ? { source: "upload", key: request.key, filename: request.file.name, totalBytes: request.file.size }
          : { source: "url", key: request.key, url: request.url }), signal: abort.signal });
        request.id = result.id;
      }
      if (alive.current) setOperation(result);
      if (request.file && result.stage === "uploading") await upload(request.file, result, abort.signal);
      if (!request.file && alive.current) setUrl("");
    } catch (cause) {
      if (alive.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Connection unavailable. Refresh status.");
    } finally {
      transferRunning.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function cancel() {
    if (!operation) return;
    controller.current?.abort();
    try {
      const result = await api(`app-installs/${operation.id}/cancel`, { method: "POST" });
      setOperation(result); setError(""); pending.current = null;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not cancel. Refresh status."); }
  }
  async function openApp(packageId: string) {
    setOpening(packageId); setNotice("");
    try { await api("apps/open", json({ packageId })); setNotice(`Opened ${packageId}.`); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : "Could not open app."); }
    finally { setOpening(""); }
  }
  async function updateRunner() {
    setUpdating(true); setError("");
    try {
      const result = await api("apps/update", { method: "POST" });
      if (result.status === "ready") { setNeedsUpdate(false); setNotice("App installation is ready."); void refresh(); void refreshOperation(); }
      else setNotice("Updating phone support. Select Check update again in a few seconds. The live screen may reconnect.");
    } catch { setError("Phone update status is unavailable. Check the update again."); }
    finally { setUpdating(false); }
  }
  const blocked = !ready || busy || active || needsUpdate;
  return <section className={s.panel} aria-label="Apps">
    <h2>Install an app</h2>
    {!ready && <p role="status">Start the phone to install apps.</p>}
    {needsUpdate && <div className={s.operation}><p>Update this phone to enable app installation. The live screen may reconnect.</p>
      <Button type="button" disabled={updating || !ready} onClick={() => { void updateRunner(); }}>{updating ? "Checking update…" : "Check update"}</Button></div>}
    <div className={`${s.drop} ${dragging ? s.dragging : ""}`}
      onDragOver={event => { event.preventDefault(); if (!blocked) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => {
        event.preventDefault(); setDragging(false);
        if (blocked) return;
        if (event.dataTransfer.files.length !== 1) { setError("Drop one APK at a time."); return; }
        void install(event.dataTransfer.files[0]);
      }}>
      <p>Drop an APK here</p>
      <Button type="button" variant="ghost" disabled={blocked} onClick={() => input.current?.click()}>Upload APK</Button>
      <input ref={input} className={s.file} type="file" accept=".apk,application/vnd.android.package-archive" disabled={blocked}
        aria-label="Choose an APK" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (file) void install(file);
        }} />
      <small>One standalone APK · Up to 250 MiB</small>
    </div>
    <form className={s.url} onSubmit={(event: FormEvent) => { event.preventDefault(); void install(); }}>
      <label htmlFor={`apk-url-${id}`}>Install from URL</label>
      <div><input id={`apk-url-${id}`} type="url" value={url} required maxLength={4096} disabled={blocked}
        placeholder="https://example.com/app.apk" autoComplete="off" spellCheck={false} onChange={event => setUrl(event.target.value)} />
        <Button disabled={blocked || !url.trim()}>Install</Button></div>
      <small>Direct HTTPS download links. No sign-in links.</small>
    </form>
    {error && <p className={s.error} role="alert">{error}</p>}
    {error && pending.current && <Button type="button" tiny variant="ghost" disabled={!ready || busy} onClick={() => { void install(undefined, true); }}>Retry connection</Button>}
    {operation && <article className={s.operation} aria-label="Installation progress">
      <p role="status"><strong>{stages[operation.stage] ?? "Checking status"}</strong></p>
      <p className={s.filename}>{operation.filename}</p>
      {["uploading", "downloading"].includes(operation.stage) && <>
        <progress aria-label={stages[operation.stage]} value={operation.totalBytes ? operation.bytesReceived : undefined} max={operation.totalBytes ?? undefined} />
        <small>{size(operation.bytesReceived)}{operation.totalBytes ? ` of ${size(operation.totalBytes)}` : " received"}</small>
      </>}
      {["validating", "installing"].includes(operation.stage) && <progress aria-label={stages[operation.stage]} />}
      {operation.stage === "installing" && <small>You can leave this tab. Installation will continue.</small>}
      {operation.stage === "uploading" && !busy && !pending.current && <p>This upload stopped when you left the page. Cancel it, then select the APK again.</p>}
      {operation.message && <p>{operation.message}</p>}
      {operation.canCancel && <Button type="button" tiny variant="ghost" onClick={() => { void cancel(); }}>Cancel</Button>}
      <Button type="button" tiny variant="ghost" disabled={!ready || busy} onClick={() => { void refreshOperation(); }}>Refresh status</Button>
    </article>}
    <div className={s.heading}><h2>Installed apps</h2><Button type="button" tiny variant="ghost" disabled={!ready} onClick={() => { void refresh(); void refreshOperation(); }}>Refresh</Button></div>
    {inventoryError && <p className={s.error} role="alert">{inventoryError}</p>}
    {ready && !inventoryError && apps === null && <p role="status">Loading apps…</p>}
    {ready && !inventoryError && apps?.length === 0 && <p>No user-installed apps yet.</p>}
    {apps && apps.length > 0 && <ul className={s.list}>{apps.map(app => <li key={app.packageId}>
      <div><strong>{app.packageId}</strong><small>Version code {app.versionCode ?? "unavailable"}</small></div>
      {app.launchable ? <Button type="button" tiny variant="ghost" disabled={!ready || !!opening} onClick={() => { void openApp(app.packageId); }}>{opening === app.packageId ? "Opening…" : "Open"}</Button> : <small>No launcher</small>}
    </li>)}</ul>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
