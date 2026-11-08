import Link from "next/link";
import { PhoneCardMenu } from "@/components/phone/phone-card-menu";
import { Button } from "@/components/ui/button";
import s from "@/components/console.module.css";
import { Pill } from "@/components/ui/pill";
import type { PhoneRow } from "@/lib/shared/fixtures";
import { PhoneMutation, KeepPhone } from "@/components/phone/phone-mutations";
import type { Retention } from "@/lib/data/retention";
import { PhonePreview } from "@/components/phone/phone-preview";

export function Thumb({ dim, sbRight = "5G", id, ready }: { dim?: boolean; sbRight?: string; id?: string; ready?: boolean }) {
  return (
    <PhonePreview id={id} ready={ready}>
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
    </PhonePreview>
  );
}

const PILL_LABEL = { running: "running", stopped: "stopped", stopping: "stopping", booting: "starting", needsyou: "failed" } as const;

export function PhoneCard({ phone, controlState, retention, codespace = null }: { phone: PhoneRow; on?: boolean; controlState?: string; retention?: Retention | null; codespace?: string | null }) {
  const noCodespace = controlState === "error" && !codespace;
  return (
    <div className={s.pcard}>
      <div className={s.pcardHead}>
        <Link href={`/app/phones/${encodeURIComponent(phone.id)}`} className={`${s.name} ${s.nameLink}`}>{phone.name}</Link>
        <Pill kind={phone.state}>{phone.statusLabel ?? PILL_LABEL[phone.state]}</Pill>
        <PhoneCardMenu id={phone.id} codespace={codespace} />
      </div>
      <div className={s.pcardBody}>
        <Thumb id={phone.id} ready={phone.screenReady} dim={phone.thumbDim} />
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
