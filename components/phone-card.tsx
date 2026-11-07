import Link from "next/link";
import { PhoneCardMenu } from "./phone-card-menu";
import { Button } from "./button";
import s from "./console.module.css";
import { Pill } from "./pill";
import type { PhoneRow } from "./fixtures";
import { PhoneMutation, KeepPhone } from "./phone-mutations";
import type { Retention } from "../lib/retention";

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

const PILL_LABEL = { running: "running", stopped: "stopped", booting: "starting", needsyou: "failed" } as const;

export function PhoneCard({ phone, controlState, retention, codespace = null }: { phone: PhoneRow; on?: boolean; controlState?: string; retention?: Retention | null; codespace?: string | null }) {
  const noCodespace = controlState === "error" && !codespace;
  return (
    <div className={s.pcard}>
      <div className={s.pcardHead}>
        <Link href={`/app/phones/${encodeURIComponent(phone.id)}`} className={`${s.name} ${s.nameLink}`}>{phone.name}</Link>
        <Pill kind={phone.state}>{PILL_LABEL[phone.state]}</Pill>
        <PhoneCardMenu id={phone.id} codespace={codespace} />
      </div>
      <div className={s.pcardBody}>
        <Thumb dim={phone.thumbDim} />
        <div className={s.meta}>
          {phone.meta.map(([k, v]) => (
            <div key={k}>
              <span className={s.k}>{k}</span>
              <span className={s.v}>{v}</span>
            </div>
          ))}
        </div>
      </div>
      <p id={`controls-${phone.id}`} className={s.srOnly}>Phone controls are not connected yet. Your codespace keeps the phone when stopped.</p>
      {retention && <div className={s.cardRetention}>
        <p className={retention.warning ? s.retentionWarning : undefined}>{retention.message}</p>
        {retention.canKeep && controlState !== "keeping" && <KeepPhone id={phone.id} />}
      </div>}
      <div className={s.pcardFoot}>
        {noCodespace ? <span className={s.cardHint}>Use ⋯ to delete it.</span>
          : controlState ? <PhoneMutation id={phone.id} state={controlState} /> : <Button tiny variant="ghost" disabled aria-describedby={`controls-${phone.id}`}>{phone.state === "stopped" ? "Wake" : "Stop"}</Button>}
        <Link href={`/app/phones/${encodeURIComponent(phone.id)}`} className={`${s.btn} ${s.btnTiny} ${s.btnFootMain}`}>
          Open phone
        </Link>
      </div>
    </div>
  );
}
