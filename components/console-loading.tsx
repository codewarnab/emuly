import s from "./console.module.css";
export function ConsoleLoading({ detail = false }: { detail?: boolean }) {
  return <div role="status" aria-label="Loading console" aria-busy="true">
    <div className={s.topbar} aria-hidden><div className={s.skeletonLine} style={{width: 120}} /><div className={s.spacer} /><div className={s.skeletonLine} style={{width: 160}} /></div>
    {detail ? <div className={s.detail} aria-hidden><div className={`${s.stage} ${s.skeletonStage}`} /><div><div className={s.skeletonLine} />{Array.from({length: 7}, (_, i) => <div key={i} className={s.skeletonRow} />)}</div></div> :
      <div className={s.pagewrap} aria-hidden><div className={s.skeletonHeading} /><div className={s.skeletonLine} /><div className={s.grid}>{[0,1].map(i => <div key={i} className={s.skeletonCard}><div className={s.skeletonLine} /><div className={s.skeletonPhone} /></div>)}</div><div className={s.skeletonRow} /></div>}
  </div>;
}
