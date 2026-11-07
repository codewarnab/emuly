"use client";
import { useActionState, useState } from "react";
import { updateAllowance } from "../app/actions/phones";
import { Button } from "./button";
import s from "./console.module.css";

export function AllowanceChoice({ allowance }: { allowance: number }) {
  const [choice, setChoice] = useState("auto");
  const [result, action, pending] = useActionState(updateAllowance, { message: "" });
  return <details className={s.allowance}><summary>Override</summary>
    <form action={action} className={s.createForm}>
      <p>Your GitHub plan sets your monthly allowance. Other codespaces use these hours too.</p>
      <label>Monthly allowance<select name="allowance" value={choice} onChange={event => setChoice(event.target.value)}>
        <option value="auto">Use GitHub plan (automatic)</option><option value="120">Free (120 core-hours)</option><option value="180">Pro (180 core-hours)</option><option value="custom">Custom</option>
      </select></label>
      {choice === "custom" && <label>Core-hours<input name="customAllowance" type="number" min="0" step="any" defaultValue={allowance} required /></label>}
      <Button tiny disabled={pending}>{pending ? "Saving…" : "Save allowance"}</Button>
      {result.message && <p role="status">{result.message}</p>}
    </form>
  </details>;
}
