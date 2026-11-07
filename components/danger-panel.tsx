"use client";
import { useActionState, useEffect, useState } from "react";
import { mutatePhone } from "../app/actions/phones";
import { Button } from "./button";
import { useToast } from "./ui-provider";
import s from "./console.module.css";

export function DangerPanel({ phoneName }: { phoneName: string }) {
  const [result, action, pending] = useActionState(mutatePhone, { message: "" });
  const [open, setOpen] = useState(false);
  const notify = useToast();
  useEffect(() => { if (result.message) notify(result.message); }, [result, notify]);
  return <section className={s.danger} aria-labelledby="delete-heading">
    <div className={s.dangerRow}>
      <div>
        <h2 id="delete-heading" className={s.dangerH}>Delete phone</h2>
        <p className={s.dangerP}>Erases the codespace, apps and snapshot. You cannot undo this.</p>
      </div>
      {!open && <Button variant="danger" tiny onClick={() => setOpen(true)}>Delete…</Button>}
    </div>
    {open && <form action={action} className={s.dangerForm}>
      <input type="hidden" name="operation" value="delete" />
      <input type="hidden" name="phoneId" value={phoneName} />
      <input type="hidden" name="confirmation" value={phoneName} />
      <span className={s.dangerP}>Delete this phone for good?</span>
      <Button variant="ghost" tiny type="button" autoFocus onClick={() => setOpen(false)}>Cancel</Button>
      <Button variant="danger" tiny disabled={pending}>{pending ? "Deleting…" : "Yes, delete"}</Button>
    </form>}
  </section>;
}
