import s from "@/components/console.module.css";
export function ConsoleLoading({ detail = false }: { detail?: boolean }) {
  return <div role="status" aria-label="Loading console" aria-busy="true">
    <div className={s.topbar} aria-hidden><div className={s.skeletonLine} style={{width: 120}} /><div className={s.spacer} /><div className={s.skeletonLine} style={{width: 160}} /></div>
    {detail ? <div className={s.detail} aria-hidden><div className={`${s.stage} ${s.skeletonStage}`} /><DetailSide /></div> :
      <div className={s.pagewrap} aria-hidden><div className={s.skeletonHeading} /><div className={s.skeletonLine} /><div className={s.grid}>{[0,1].map(i => <div key={i} className={s.skeletonCard}><div className={s.skeletonLine} /><div className={s.skeletonPhone} /></div>)}</div><div className={s.skeletonRow} /></div>}
  </div>;
}

/** Matches the phone page: tabs, the activity log, then the host codespace specs. */
function DetailSide() {
  return <div className={s.skelSide}>
    <div className={s.skelTabs}>{[88, 44, 56].map(w => <span key={w} style={{ width: w }} />)}</div>
    {[180, 140, 170, 130].map((w, i) => <div key={i} className={s.skelLog}><span /><span style={{ width: w }} /></div>)}
    <div className={s.skelSpecs}>
      <span className={s.skelSpecTitle} />
      {[0, 1, 2, 3].map(i => <div key={i} className={s.skelSpec}><span /><span /></div>)}
    </div>
  </div>;
}
