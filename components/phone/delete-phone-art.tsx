import h from "@/components/marketing/hero-phone.module.css";
import s from "@/components/phone/delete-phone-art.module.css";

const APPS = ["Studio", "Messages", "Photos", "Calendar", "Files", "Clock", "Notes", "Settings"];

/** Decorative: the phone shows a delete sheet and waits for the user's decision. */
export function DeletePhoneArt({ name }: { name: string }) {
  return <div>
    <div className={h.stage} role="img" aria-label={`${name} waits while you decide whether to delete it.`}>
      <div className={h.phone} aria-hidden="true">
        <span className={h.btnPower} /><span className={h.btnVol} />
        <div className={h.screen}>
          <div className={h.status}><span>9:41</span><span className={h.icons}><span className={h.battery} /></span></div>
          <div className={`${h.view} ${h.home} ${s.still}`}>
            <div className={h.glance}><span>{name}</span><b>Agent request<br />waiting for you.</b></div>
            <div className={h.grid}>{APPS.map((app, i) => <div key={app} className={h.appIcon}><span className={`${h.icon} ${h[`icon${i}`]}`}><i /></span><small>{app}</small></div>)}</div>
          </div>
          <div className={s.dim} />
          <div className={s.sheet}>
            <span className={s.grip} />
            <span className={s.bin}><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg></span>
            <b>Delete this phone?</b>
            <p>{name}</p>
            <div className={s.buttons}><span className={s.keep}>Keep it</span><span className={s.del}>Delete</span></div>
          </div>
          <div className={h.navbar} /><div className={h.glare} /><span className={h.camera}><i /></span>
        </div>
      </div>
    </div>
    <p className={s.pill} aria-hidden="true"><span className={s.dot} />agent · waiting for you</p>
  </div>;
}
