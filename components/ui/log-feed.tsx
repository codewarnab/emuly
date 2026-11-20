import { Fragment } from "react";
import s from "@/components/console.module.css";
import type { LogPart } from "@/lib/shared/fixtures";
import { utcLabel } from "@/lib/shared/relative-time";

/** `at` is the ISO time used to show when the event happened. */
export type LogRow = {
  time: string; at?: string; ok?: boolean; error?: boolean; parts: LogPart[];
  /** True for a call an agent made. The row starts with an [agent] tag. */
  agent?: boolean;
  /** The stored command. A click on the row shows it under the text. */
  detail?: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Rows shown before the rest folds under "View all". */
const FOLD_AT = 13;

/** "8 Nov" from a `YYYY-MM-DD` key. */
function dayLabel(key: string) {
  const [, month, day] = key.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? ""}`.trim();
}

/** A row with a command opens on click to show it. A native <details> needs no client code. */
function FeedRow({ row }: { row: LogRow }) {
  const className = `${s.feedRow} ${row.error ? s.feedErr : ""}`;
  const cells = <>
    <span className={s.feedT}>
      {row.at ? <time dateTime={row.at} title={utcLabel(row.at)}>{row.at.slice(11, 16)}</time> : row.time}
    </span>
    <span className={s.feedM}>
      {row.agent && <span className={s.feedAgent}>[agent]</span>}
      {row.parts.map((p, j) =>
        p.type === "code" ? <code key={j}>{p.value}</code> : <span key={j}>{p.value}</span>,
      )}
    </span>
  </>;
  if (!row.detail) return <div className={className}>{cells}</div>;
  return <details className={s.feedDetails}>
    <summary className={className} title="Show the command">{cells}</summary>
    <div className={s.feedCmd}><code>{row.detail}</code></div>
  </details>;
}

export function LogFeed({ title, rows, live = true, running, emptyMessage = "No activity yet. Updates will appear when this phone connects." }: {
  /** Heading above the feed. Omit when the tab label already names the list. */
  title?: string; rows: LogRow[]; live?: boolean; emptyMessage?: string;
  /** Text for a step that still runs, such as "Setting up…". */
  running?: string;
}) {
  // Newest first, grouped by day so a long list stays readable.
  const days: { key: string; rows: LogRow[] }[] = [];
  for (const row of rows) {
    const key = row.at ? row.at.slice(0, 10) : "";
    const last = days[days.length - 1];
    if (last?.key === key) last.rows.push(row);
    else days.push({ key, rows: [row] });
  }
  const items = days.flatMap(day => day.rows.map((row, index) => ({ row, dayKey: day.key, start: index === 0 })));
  const folded = items.length > FOLD_AT;
  const shown = folded ? items.slice(0, FOLD_AT) : items;
  const rest = folded ? items.slice(FOLD_AT) : [];

  const render = (list: typeof items) => list.map((item, index) => (
    <Fragment key={index}>
      {item.start && item.dayKey && <h5 className={s.feedDayH}>{dayLabel(item.dayKey)}</h5>}
      <FeedRow row={item.row} />
    </Fragment>
  ));

  return (
    <div className={s.logbox}>
      {(title || live) && <div className={s.rh}>
        {title && <h4>{title}</h4>}
        {live && (
          <span className={s.live}>
            <i />
            streaming
          </span>
        )}
      </div>}
      <div className={s.feed}>
        {running && <div className={`${s.feedRow} ${s.feedNow}`} role="status">
          <span className={s.feedT}>now</span>
          <span className={s.feedM}>{running}</span>
        </div>}
        {render(shown)}
        {rest.length > 0 && <details className={s.fold}>
          <summary className={s.foldSummary}>
            <span className={s.foldClosed}>View {rest.length} more {rest.length === 1 ? "event" : "events"}</span>
            <span className={s.foldOpen}>Show fewer</span>
          </summary>
          {render(rest)}
        </details>}
      </div>
      {rows.length === 0 && <p className={s.feedEmpty}>{emptyMessage}</p>}
    </div>
  );
}
