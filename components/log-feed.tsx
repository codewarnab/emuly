import s from "./console.module.css";
import type { LogPart } from "./fixtures";
import { TimeAgo } from "./event-time";

/** `at` is the ISO time used to show when the event happened. */
export type LogRow = { time: string; at?: string; ok?: boolean; error?: boolean; parts: LogPart[] };

export function LogFeed({ title, rows, live = true, running, emptyMessage = "No activity yet. Updates will appear when this phone connects." }: {
  title: string; rows: LogRow[]; live?: boolean; emptyMessage?: string;
  /** Text for a step that still runs, such as "Setting up…". */
  running?: string;
}) {
  const last = rows.at(-1)?.at;
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
            <span className={s.rowT}>{r.at ? <TimeAgo at={r.at} /> : r.time}</span>
            <span className={`${s.rowM} ${r.error ? s.rowErr : r.ok ? s.rowOk : ""}`}>
              {r.parts.map((p, j) =>
                p.type === "code" ? <code key={j}>{p.value}</code> : <span key={j}>{p.value}</span>,
              )}
            </span>
          </div>
      ))}
      {running && last && <div className={s.row} role="status">
        <span className={s.rowT}>now</span>
        <span className={s.rowM}>{running}</span>
      </div>}
    </div>
  );
}
