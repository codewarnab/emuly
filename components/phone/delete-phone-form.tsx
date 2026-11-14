"use client";
import { useActionState, useEffect } from "react";
import { approvePhoneDelete, denyPhoneDelete, type DeletePhoneActionResult } from "@/app/actions/phone-delete";
import { useToast } from "@/components/ui/ui-provider";
import s from "@/components/link/link.module.css";

const EMPTY: DeletePhoneActionResult = { ok: false, message: "" };

export function DeletePhoneForm({ request, phoneName }: { request: string; phoneName: string }) {
  const [approved, approve, approving] = useActionState(approvePhoneDelete, EMPTY);
  const [denied, deny, denying] = useActionState(denyPhoneDelete, EMPTY);
  const notify = useToast();
  const busy = approving || denying;

  // Success re-renders the page into its final state, so only failures need a toast.
  useEffect(() => { if (approved.message && !approved.ok) notify(approved.message); }, [approved, notify]);
  useEffect(() => { if (denied.message && !denied.ok) notify(denied.message); }, [denied, notify]);

  return <form action={approve} className={s.confirmForm}>
    <input type="hidden" name="request" value={request} />
    <input type="hidden" name="confirmation" value={phoneName} />
    <div className={s.deleteActions}>
      <button type="submit" className={s.dangerButton} disabled={busy}>{approving ? "Deleting…" : "Delete phone"}</button>
      <button type="submit" formAction={deny} className={s.quiet} disabled={busy}>{denying ? "Keeping…" : "Keep it"}</button>
    </div>
  </form>;
}
