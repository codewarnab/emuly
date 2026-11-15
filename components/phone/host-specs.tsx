import type { ReactNode } from "react";
import s from "./host-specs.module.css";

/** The host codespace as 4 icon tiles: CPU, RAM, disk and idle stop. */
const icon = (d: ReactNode) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;

const ICONS: Record<string, ReactNode> = {
  CPU: icon(<><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx=".5" /><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3" /></>),
  RAM: icon(<><rect x="2.5" y="7" width="19" height="9" rx="1.5" /><path d="M6.5 10v3M10 10v3M14 10v3M17.5 10v3M5 16v2.5M19 16v2.5" /></>),
  Disk: icon(<><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>),
  "Idle stop": icon(<><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2M9.5 2.5h5" /></>),
};

export function HostSpecs({ rows }: { rows: Array<[string, string]> }) {
  return <section className={s.specs} aria-label="Host codespace">
    <h5>Host</h5>
    <dl>
      {rows.map(([k, v]) => <div key={k} className={s.tile}>
        <span className={s.icon}>{ICONS[k]}</span>
        <dt>{k}</dt>
        <dd title={k}>{k === "Idle stop" ? `${v} idle` : v}</dd>
      </div>)}
    </dl>
  </section>;
}
