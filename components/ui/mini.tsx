import s from "@/components/console.module.css";
import { CopyButton } from "@/components/ui/copy-button";

/** A row is [label, value], or [label, value, info]. The info text shows behind a small ⓘ on hover or focus. */
export type MiniRow = [string, string] | [string, string, string];

export function Mini({ title, rows }: { title: string; rows: MiniRow[] }) {
  return (
    <div className={s.mini}>
      <h5 className={s.miniH}>{title}</h5>
      {rows.map(([k, v, info]) => (
        <div className={s.kv} key={k}>
          <span className={s.k}>{k}{info && <span className={s.info} title={info} aria-label={info} role="img" tabIndex={0}>ⓘ</span>}</span>
          <span className={`${s.kvV} ${s.copyValue}`}>{v}{["slot", "adb"].includes(k.toLowerCase()) && <CopyButton text={v} description={`Copy ${k}`} />}</span>
        </div>
      ))}
    </div>
  );
}

export function UrlRow({ url }: { url: string }) {
  return (
    <div className={s.urlrow}>
      <code>{url}</code>
      <CopyButton text={url} />
    </div>
  );
}
