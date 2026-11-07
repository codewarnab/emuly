import s from "./console.module.css";
import { CopyButton } from "./copy-button";

export function Mini({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className={s.mini}>
      <h5 className={s.miniH}>{title}</h5>
      {rows.map(([k, v]) => (
        <div className={s.kv} key={k}>
          <span className={s.k}>{k}</span>
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
