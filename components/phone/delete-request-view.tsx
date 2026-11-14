import { DeletePhoneForm } from "@/components/phone/delete-phone-form";
import s from "@/components/link/link.module.css";

/** The pending delete request: the phone, a warning, and the typed confirmation. */
export function DeleteRequestView({ token, name, state, apps }: {
  token: string; name: string; state: string; apps: number | null;
}) {
  return <div className={s.deleteView}>
    <p className={s.eyebrow} data-state="denied">Agent request</p>
    <h1 id="delete-title" className={s.title}>Delete this phone?</h1>
    <p className={s.sub}>An agent asked to delete this phone. You decide.</p>
    <div className={s.phoneRow}>
      <span className={s.phoneIcon} aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M11 18h2" /></svg>
      </span>
      <div className={s.phoneMeta}>
        <p className={s.phoneName}>{name}</p>
        <p className={s.phoneApps}>{apps === null ? "App count not available" : `${apps} installed ${apps === 1 ? "app" : "apps"}`}</p>
      </div>
      <span className={s.statePill} data-state={state}>{state.replaceAll("_", " ")}</span>
    </div>
    <p className={s.warn}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
      <span>This removes the codespace and all its data. You cannot undo it.</span>
    </p>
    <DeletePhoneForm request={token} phoneName={name} />
  </div>;
}
