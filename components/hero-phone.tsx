import s from "./hero-phone.module.css";

const GRID = ["#e8def8", "#c4eed0", "#ffd8e4", "#d3e3fd", "#fce8b2", "#c2e7ff", "#ffdad6", "#dde3ea"];
const DOCK = ["#1a73e8", "#188038", "#d93025", "#f9ab00"];
const LOG = [
  ["tap", "app icon"],
  ["type", "qa@test.dev"],
  ["tap", "Sign in"],
  ["screenshot", "saved"],
  ["assert", "“Signed in” ✓"],
];

/** Stock Android phone that an AI agent drives in a loop: tap, type, screenshot, assert. Pure CSS. */
export function HeroPhone() {
  return <div className={s.stage} role="img" aria-label="An AI agent taps, types, and takes screenshots on a cloud Android phone">
    <div className={s.phone}>
      <span className={s.btnPower} /><span className={s.btnVol} />
      <div className={s.screen}>
        <div className={s.status}><span>9:41</span><span className={s.camera} /><span className={s.icons}><i className={s.wifi} /><i className={s.signal} /><i className={s.battery} /></span></div>

        {/* Home screen */}
        <div className={`${s.view} ${s.home}`}>
          <div className={s.glance}><b>Sat, Nov 7</b><span>18&deg; Partly cloudy</span></div>
          <div className={s.grid}>{GRID.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
          <div className={s.dock}>{DOCK.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
          <div className={s.search}><span className={s.g}>G</span><span className={s.mic} /></div>
        </div>

        {/* App under test */}
        <div className={`${s.view} ${s.app}`}>
          <div className={s.appBar}>Sign in</div>
          <label className={s.field}><small>Email</small><span className={s.typed}>qa@test.dev</span><span className={s.caret} /></label>
          <label className={s.field}><small>Password</small><span className={s.dots}>&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</span></label>
          <span className={s.cta}>Sign in</span>
        </div>

        {/* Result */}
        <div className={`${s.view} ${s.done}`}>
          <div className={s.appBar}>Home</div>
          <div className={s.check}>&#10003;</div>
          <p>Signed in</p>
          <span className={s.card} /><span className={s.card} />
        </div>

        <div className={s.flash} />
        <div className={s.shot}><span /><small>Screenshot saved</small></div>
        <div className={s.navbar} />

        <div className={s.cursor}>
          <span className={s.ripple} />
          <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true"><path d="M1 1l15 9.5-6.6 1.4 3.9 7.6-3 1.5-3.9-7.6L1 18z" /></svg>
          <span className={s.tag}>agent</span>
        </div>
      </div>
    </div>

    <ol className={s.log} aria-hidden="true">
      {LOG.map(([verb, arg], i) => <li key={i} className={s[`l${i + 1}`]}><b>{verb}</b> {arg}</li>)}
    </ol>
  </div>;
}
