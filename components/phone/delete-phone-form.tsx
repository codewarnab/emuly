"use client";
import { useActionState, useEffect, useState } from "react";
import { approvePhoneDelete, denyPhoneDelete, type DeletePhoneActionResult } from "@/app/actions/phone-delete";
import { useToast } from "@/components/ui/ui-provider";
import s from "@/components/link/link.module.css";

const EMPTY: DeletePhoneActionResult = { ok: false, message: "" };

export function DeletePhoneForm({ request, phoneName }: { request: string; phoneName: string }) {
  const [approved, approve, approving] = useActionState(approvePhoneDelete, EMPTY);
  const [denied, deny, denying] = useActionState(denyPhoneDelete, EMPTY);
  const [typed, setTyped] = useState("");
  const notify = useToast();
  const busy = approving || denying;
  const ready = typed === phoneName && !busy;

  // Success re-renders the page into its final state, so only failures need a toast.
  useEffect(() => { if (approved.message && !approved.ok) notify(approved.message); }, [approved, notify]);
  useEffect(() => { if (denied.message && !denied.ok) notify(denied.message); }, [denied, notify]);

  return <form action={approve} className={s.confirmForm}>
    <input type="hidden" name="request" value={request} />
    <label className={s.fieldLabel} htmlFor="confirm-phone-name">
      Type <b>{phoneName}</b> to confirm
    </label>
    <input id="confirm-phone-name" name="confirmation" className={s.confirmInput} value={typed}
      onChange={event => setTyped(event.target.value)} autoComplete="off" autoCapitalize="none"
      spellCheck={false} disabled={busy} />
    <div className={s.deleteActions}>
      <button type="submit" className={s.dangerButton} disabled={!ready}>{approving ? "Deleting…" : "Delete phone"}</button>
      <button type="submit" formAction={deny} className={s.quiet} disabled={busy}>{denying ? "Keeping…" : "Keep it"}</button>
    </div>
  </form>;
}
