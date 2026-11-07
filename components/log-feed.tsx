import s from "./console.module.css";
import type { LogPart } from "./fixtures";

export type LogRow = { time: string; ok?: boolean; parts: LogPart[] };

export function LogFeed({ title, rows, live = true, emptyMessage = "No activity yet. Updates will appear when this phone connects." }: { title: string; rows: LogRow[]; live?: boolean; emptyMessage?: string }) {
  return (
    <div className={s.logbox}>
      <div className={s.rh}>
        <h4>{title}</h4>
        {live && (
          <span className={s.live}>
            <i />
            streaming
          </span>
        )}
      </div>
      {rows.length === 0 && <p className={s.emptySub}>{emptyMessage}</p>}
      {rows.map((r, i) => (
        <div className={s.row} key={i}>
          <span className={s.rowT}>{r.time}</span>
          <span className={`${s.rowM} ${r.ok ? s.rowOk : ""}`}>
            {r.parts.map((p, j) =>
              p.type === "code" ? <code key={j}>{p.value}</code> : <span key={j}>{p.value}</span>,
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
