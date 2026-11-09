"use client";
import { useActionState, useEffect } from "react";
import { approveDevice, denyDevice, type DeviceActionResult } from "@/app/actions/devices";
import { useToast } from "@/components/ui/ui-provider";
import s from "@/components/link/link.module.css";

const EMPTY: DeviceActionResult = { ok: false, message: "" };

export function DeviceActions({ code }: { code: string }) {
  const [approved, approve, approving] = useActionState(approveDevice, EMPTY);
  const [denied, deny, denying] = useActionState(denyDevice, EMPTY);
  const notify = useToast();
  const busy = approving || denying;

  // Success re-renders the page into its final state, so only failures need a toast.
  useEffect(() => { if (approved.message && !approved.ok) notify(approved.message); }, [approved, notify]);
  useEffect(() => { if (denied.message && !denied.ok) notify(denied.message); }, [denied, notify]);

  return <div className={s.actions}>
    <form action={approve}>
      <input type="hidden" name="code" value={code} />
      <button type="submit" className={s.primary} disabled={busy}>{approving ? "Approving…" : "Approve"}</button>
    </form>
    <form action={deny}>
      <input type="hidden" name="code" value={code} />
      <button type="submit" className={s.quiet} disabled={busy}>{denying ? "Denying…" : "Deny"}</button>
    </form>
  </div>;
}
