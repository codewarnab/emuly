"use client";
import { useState } from "react";
import s from "./console.module.css";
import { Button } from "./button";

export function DangerPanel({ phoneName }: { phoneName: string }) {
  const [notice, setNotice] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  return <section className={s.dialog} aria-labelledby="delete-heading">
    <h2 id="delete-heading" className={s.dialogH}>Delete {phoneName}</h2>
    <p className={s.dialogP}>Stopping is safe. Your codespace keeps the phone and its snapshot.</p>
    <p className={s.dialogP}>Deleting the codespace erases this phone, its apps, and its saved snapshot. This cannot be undone.</p>
    <label className={s.fieldLabel} htmlFor="delete-confirmation">Type <b>{phoneName}</b> to confirm</label>
    <input id="delete-confirmation" className={s.field} value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby="delete-note" />
    <p id="delete-note" className={s.loginFoot}>Deletion is not connected yet. No codespace will be changed.</p>
    <div className={s.acts}>
      <Button variant="ghost" tiny onClick={() => setConfirmation("")}>Cancel</Button>
      <Button variant="danger" tiny aria-describedby="delete-note" title={`Type ${phoneName} to confirm; deletion is not available yet`} disabled={confirmation !== phoneName} onClick={() => setNotice(true)}>Delete forever</Button>
    </div>
  {notice && <p role="status" className={s.loginFoot}>Deletion is unavailable. Your phone has not changed.</p>}
  </section>;
}
