import Link from "next/link";
import { CopyButton } from "./copy-button";
import { Button } from "./button";
import s from "./console.module.css";
import { Pill } from "./pill";
import type { PhoneRow } from "./fixtures";

export function Thumb({ dim, sbRight = "5G" }: { dim?: boolean; sbRight?: string }) {
  return (
    <div className={s.thumb}>
      <div className={`${s.scr} ${dim ? s.scrDim : ""}`}>
        <div className={s.sb}>
          <span>9:41</span>
          <span>{sbRight}</span>
        </div>
        <div className={s.tm}>9:41</div>
        <div className={s.aps}>
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
    </div>
  );
}

export function PhoneCard({ phone }: { phone: PhoneRow; on?: boolean }) {
  return (
    <div className={s.pcard}>
      <div className={s.pcardHead}>
        <span className={s.name}>{phone.name}</span>
        <Pill kind={phone.state}>{phone.state}</Pill>
      </div>
      <div className={s.pcardBody}>
        <Thumb dim={phone.thumbDim} />
        <div className={s.meta}>
          {phone.meta.map(([k, v]) => (
            <div key={k}>
              <span className={s.k}>{k}</span>
              <span className={`${s.v} ${s.copyValue}`}>{v}{k.toLowerCase() === "slot" && <CopyButton text={v} description={`Copy codespace name ${v}`} />}</span>
            </div>
          ))}
        </div>
      </div>
      <p id={`controls-${phone.id}`} className={s.srOnly}>Phone controls are not connected yet. Your codespace keeps the phone when stopped.</p>
      <div className={s.pcardFoot}>
        <Button tiny variant="ghost" disabled aria-describedby={`controls-${phone.id}`}>{phone.state === "stopped" ? "Wake" : "Stop"}</Button>
        <Link href={`/app/phones/${encodeURIComponent(phone.id)}?tab=backups`} className={s.cardLink}>Backups</Link>
        <Link href={`/app/phones/${encodeURIComponent(phone.id)}`} className={`${s.btn} ${s.btnTiny} ${s.btnFootMain}`}>
          Open phone
        </Link>
      </div>
    </div>
  );
}
