import s from "@/components/marketing/hero-phone.module.css";

const APPS = ["Studio", "Messages", "Photos", "Calendar", "Files", "Clock", "Notes", "Settings"];
const LOG = [["tap", "Studio"], ["type", "qa@test.dev"], ["tap", "Sign in"], ["screenshot", "saved"], ["assert", '"Signed in"']];

/** Decorative Android test run. All motion shares one 12-second CSS timeline. */
export function HeroPhone() {
  return <div className={s.stage} role="img" aria-label="An AI agent opens Studio on a cloud Pixel 8, types qa@test.dev, signs in, saves a screenshot, verifies Signed in, and swipes home.">
    <div className={s.phone} aria-hidden="true">
      <span className={s.btnPower} /><span className={s.btnVol} />
      <div className={s.screen}>
        <div className={s.status}><span>9:41</span><span className={s.icons}>
          <svg viewBox="0 0 16 12"><path d="M1 3.5Q8-2 15 3.5M3.5 6Q8 2.5 12.5 6M6 8.5Q8 7 10 8.5" /><circle cx="8" cy="11" r=".7" /></svg>
          <svg viewBox="0 0 12 12"><path d="M1 11V9M4 11V6M7 11V3M10 11V1" /></svg>
          <span className={s.battery} />
        </span></div>
        <div className={`${s.view} ${s.home}`}>
          <div className={s.glance}><span>Saturday, Nov 7</span><b>Make room<br />for a little more.</b><small><i />18° · Partly cloudy</small></div>
          <div className={s.grid}>{APPS.map((name, i) => <div key={name} className={s.appIcon}><span className={`${s.icon} ${s[`icon${i}`]}`}><i /></span><small>{name}</small></div>)}</div>
          <div className={s.dock}>{["Phone", "Messages", "Browser", "Camera"].map((name, i) => <span key={name} className={`${s.icon} ${s[`dock${i}`]}`}><i /></span>)}</div>
          <div className={s.search}><span className={s.searchGlyph} /><span>Search your phone</span><i className={s.mic} /></div>
        </div>
        <div className={`${s.view} ${s.app}`}>
          <div className={s.appBar}><span className={s.back}>‹</span><span>Studio</span><span className={s.menu}>⋮</span></div>
          <div className={s.intro}><span className={s.studioMark}>✦</span><h3>Welcome back</h3><p>Your space to make things.</p></div>
          <div className={`${s.field} ${s.email}`}><small>Email address</small><span className={s.typed}>qa@test.dev</span><span className={s.caret} /></div>
          <div className={`${s.field} ${s.password}`}><small>Password</small><span className={s.dots}>••••••••</span><span className={s.eye} /></div>
          <span className={s.forgot}>Forgot password?</span>
          <span className={s.cta}>Sign in <span>→</span></span>
          <span className={s.secure}><i />Your workspace, securely connected</span>
        </div>
        <div className={`${s.view} ${s.done}`}>
          <div className={s.appBar}><span className={s.miniMark}>✦</span><span>Studio</span><span className={s.avatar}>Q</span></div>
          <div className={s.success}><span className={s.check}><svg viewBox="0 0 32 32"><path d="m8 16 5 5 11-11" /></svg></span><h3>Signed in</h3><p>Good to see you, Alex.</p></div>
          <div className={s.workspace}><span>YOUR WORKSPACE</span><b>A little progress, every day.</b><div className={s.projectArt}><i /><i /><i /></div><div className={s.projectMeta}><b>Weekend ideas</b><small>Edited just now <span>↗</span></small></div></div>
          <div className={s.activity}><span>✓</span><div><b>Everything is up to date</b><small>All changes saved to your space</small></div></div>
        </div>
        <div className={s.flash} />
        <div className={s.shot}><div className={s.shotPreview}><span>✦ Studio</span><b>✓</b><strong>Signed in</strong><i /><i /></div><small>Screenshot saved</small></div>
        <div className={s.navbar} /><div className={s.glare} /><span className={s.camera}><i /></span>
        <div className={s.cursor}>
          <span className={s.ripple} />
          <svg width="18" height="22" viewBox="0 0 18 22"><path d="M1 1l15 9.5-6.6 1.4 3.9 7.6-3 1.5-3.9-7.6L1 18z" /></svg>
          <span className={s.tag}>agent</span>
        </div>
      </div>
    </div>
    <div className={s.agentPanel} aria-hidden="true">
      <span className={s.liveDot} /><b className={s.agentName}>agent</b>
      <ol className={s.log}>{LOG.map(([verb, arg], i) => <li key={i} className={s[`l${i + 1}`]}><span className={s.stepStatus} /><b>{verb}</b><span>{arg}</span></li>)}</ol>
      <span className={s.count}><span className={s.running}>running</span><span className={s.complete}>passed</span></span>
      <span className={s.progress} />
    </div>
  </div>;
}
