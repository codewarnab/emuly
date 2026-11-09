"use client";
import { useEffect, useState, useTransition } from "react";
import type { AgentKey } from "@/lib/data/agents";
import type { AgentPhoneDeletion } from "@/lib/data/phone-deletions";
import { revokeAgentKey, revokeAllAgentKeys, saveAgentDeletePhones } from "@/app/actions/agents";
import { Button } from "@/components/ui/button";
import { timeAgo, utcLabel } from "@/lib/shared/relative-time";
import s from "@/components/console.module.css";

export function ConnectedAgents({ initial, deleteWithoutAsking, deletions }: {
  initial: AgentKey[]; deleteWithoutAsking: boolean; deletions: AgentPhoneDeletion[];
}) {
  const [keys, setKeys] = useState(initial);
  const [deletePhones, setDeletePhones] = useState(deleteWithoutAsking);
  const [status, setStatus] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);
  const [now, setNow] = useState(0);
  const [pending, startTransition] = useTransition();
  // Render exact UTC on the server and in the first client pass, then switch to relative time.
  useEffect(() => { setNow(Date.now()); }, []);
  const clock = now || 0;
  const active = keys.filter(key => !key.revoked_at && Date.parse(key.expires_at) > clock).length;

  function revoke(id: number) {
    startTransition(async () => {
      const result = await revokeAgentKey(id);
      setStatus(result.message);
      if (result.ok) setKeys(current => current.map(key => key.id === id && !key.revoked_at
        ? { ...key, revoked_at: new Date().toISOString() } : key));
    });
  }
  function toggleDeleteWithoutAsking(value: boolean) {
    startTransition(async () => {
      const result = await saveAgentDeletePhones(value);
      setStatus(result.message);
      if (result.ok) setDeletePhones(value);
    });
  }
  function revokeAll() {
    startTransition(async () => {
      const result = await revokeAllAgentKeys();
      setStatus(result.message);
      setConfirmAll(false);
      if (result.ok) {
        const at = new Date().toISOString();
        setKeys(current => current.map(key => key.revoked_at ? key : { ...key, revoked_at: at }));
      }
    });
  }

  return <div className={s.agents}>
    <div className={s.agentHeader}>
      <p className={s.settingHint}>Each key is one device or coding agent. Revoking it signs that agent out on its next request.</p>
      {active > 0 && (confirmAll
        ? <div className={s.inlineConfirm}>
            <span>Revoke all {active} active {active === 1 ? "agent" : "agents"}?</span>
            <Button tiny variant="danger" disabled={pending} onClick={revokeAll}>Revoke all</Button>
            <Button tiny variant="ghost" onClick={() => setConfirmAll(false)}>Cancel</Button>
          </div>
        : <Button tiny variant="ghost" disabled={pending} onClick={() => setConfirmAll(true)}>Revoke all</Button>)}
    </div>
    <p className={s.saveStatus} role="status">{status}</p>
    <label className={s.settingToggle}>
      <span><b>Let agents delete phones without asking</b>
        <small>Off by default. When off, an agent sends you a link to approve each deletion.</small></span>
      <input type="checkbox" role="switch" className={s.switch} checked={deletePhones} disabled={pending}
        onChange={event => toggleDeleteWithoutAsking(event.target.checked)} />
    </label>
    {keys.length === 0
      ? <p className={s.settingHint}>No connected agents yet. Click Copy prompt on the Phones page to add one.</p>
      : <div className={s.agentTableWrap}>
          <table className={s.agentTable}>
            <caption className={s.agentCaption}>Connected agents</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col">Expires</th><th scope="col">Status</th><th scope="col"><span className={s.srOnly}>Action</span></th></tr></thead>
            <tbody>{keys.map(key => {
              const expired = Date.parse(key.expires_at) <= clock;
              const state = key.revoked_at ? "Revoked" : expired ? "Expired" : "Active";
              return <tr key={key.id}>
                <th scope="row">{key.name}</th>
                <td>{utcLabel(key.created_at)}</td>
                <td>{key.last_used_at ? (now ? timeAgo(key.last_used_at, now) : utcLabel(key.last_used_at)) : "Never"}</td>
                <td>{utcLabel(key.expires_at)}</td>
                <td><span className={s.agentState} data-state={state.toLowerCase()}>{state}</span></td>
                <td>{!key.revoked_at && !expired && <Button tiny variant="danger" disabled={pending} onClick={() => revoke(key.id)}>Revoke</Button>}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>}
    {deletions.length > 0 && <section className={s.agentDeletions}>
      <h2>Deleted by agents</h2>
      <div className={s.agentTableWrap}>
        <table className={s.agentTable}>
          <caption className={s.agentCaption}>Phones deleted by agents</caption>
          <thead><tr><th scope="col">Phone</th><th scope="col">Agent</th><th scope="col">Deleted</th></tr></thead>
          <tbody>{deletions.map(item => <tr key={item.id}>
            <th scope="row">{item.phone_name}</th>
            <td>{item.agent_key_name}</td>
            <td>{now ? timeAgo(item.deleted_at, now) : utcLabel(item.deleted_at)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>}
  </div>;
}
