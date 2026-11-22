import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { Brand } from "@/components/shell/topbar";
import { COMPARE_CHECKED, COMPARE_DESCRIPTION, COMPARE_FAQS, COMPARE_TITLE, ROWS, VERSUS, compareJsonLd } from "../../../lib/compare-content";
import s from "./compare.module.css";

export const metadata: Metadata = {
  title: COMPARE_TITLE,
  description: COMPARE_DESCRIPTION,
  keywords: ["free Android emulator online", "Android emulator in the cloud free", "BrowserStack alternative free", "Appetize alternative", "Genymotion cloud alternative", "Revyl alternative", "Limrun alternative", "run Android in browser"],
  alternates: { canonical: "/compare", types: { "text/markdown": "/compare.md" } },
  openGraph: { type: "article", url: "/compare", title: COMPARE_TITLE, description: COMPARE_DESCRIPTION, siteName: "Emuly" },
  twitter: { card: "summary_large_image", title: COMPARE_TITLE, description: COMPARE_DESCRIPTION },
};

const MAX = Math.max(...ROWS.map(r => r.minutes));
const Yes = () => <span className={s.yes}>Yes</span>;
const No = () => <span className={s.no}>No</span>;

export default function ComparePage() {
  return <div className={s.root}>
    <nav className={s.nav} aria-label="Main"><Brand /><div><ThemeToggle /><Link href="/">Home</Link></div></nav>
    <main id="main-content" tabIndex={-1} className={s.wrap}>
      <header className={s.head}>
        <span className={s.eyebrow}><span className={s.dot} />Prices checked {COMPARE_CHECKED}</span>
        <h1>Free Android emulators online, <em>compared</em></h1>
        <p className={s.lead}>Most cloud emulators give you a few free minutes. Emuly gives you hours, every month.</p>
        <div className={s.heroCtas}><Link href="/" className={s.button}>Start a free phone</Link><a href="#table-title" className={s.ghost}>See the table</a></div>
      </header>

      <section className={s.stats} aria-label="Emuly in numbers">
        <div className={s.featured}><strong>~30 h</strong><span>free each month on GitHub Free</span></div>
        <div><strong>~45 h</strong><span>free each month on GitHub Pro</span></div>
        <div><strong>$0</strong><span>no card, open source (MIT)</span></div>
      </section>

      <section className={s.card} aria-labelledby="chart-title">
        <h2 id="chart-title">Free emulator time</h2>
        <p className={s.sub}>Minutes you can use for free. Only Emuly, Revyl and Appetize give the time again every month.</p>
        <ul className={s.chart}>
          {ROWS.map((r, i) => <li key={r.name} className={r.name === "Emuly" ? s.us : undefined}>
            <span className={s.label}>{r.name}</span>
            <span className={s.track}><span className={s.bar} style={{ width: `max(6px, ${(r.minutes / MAX) * 100}%)`, animationDelay: `${i * 70}ms` }} /></span>
            <span className={s.value}>{r.free}</span>
          </li>)}
        </ul>
      </section>

      <section className={s.card} aria-labelledby="table-title">
        <h2 id="table-title">Side by side</h2>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead><tr><th scope="col">Service</th><th scope="col">Free time</th><th scope="col">Every month</th><th scope="col">Limit</th><th scope="col">Agent API</th><th scope="col">Good for</th></tr></thead>
            <tbody>
              {ROWS.map(r => <tr key={r.name} className={r.name === "Emuly" ? s.usRow : undefined}>
                <th scope="row">{r.name}</th><td className={s.num}>{r.free}</td><td>{r.repeats ? <Yes /> : <No />}</td><td>{r.limit}</td><td>{r.agent ? <Yes /> : <No />}</td><td>{r.best}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <p className={s.checked}>Checked {COMPARE_CHECKED}. Free tiers change, so check each pricing page.</p>
      </section>

      <section aria-labelledby="vs-title">
        <h2 id="vs-title" className={s.h2}>Which one should you pick?</h2>
        <div className={s.vsGrid}>
          {VERSUS.map(v => <article key={v.name} className={s.vs}>
            <h3>Emuly vs {v.name}</h3>
            <p className={s.them}>{v.name}: {v.them}</p>
            <dl>
              <div className={s.theirs}><dt>Pick {v.name} for</dt><dd>{v.theyWin}</dd></div>
              <div className={s.ours}><dt>Pick Emuly for</dt><dd>{v.emulyWins}</dd></div>
            </dl>
          </article>)}
        </div>
      </section>

      <section className={s.banner}>
        <div><strong>Try a free Android phone now</strong><span>Sign in with GitHub. The phone runs in your own codespace.</span></div>
        <Link href="/" className={s.button}>Start a free phone</Link>
      </section>

      <section className={s.faq} aria-labelledby="faq-title">
        <h2 id="faq-title" className={s.h2}>Questions</h2>
        {COMPARE_FAQS.map(f => <details key={f.q}><summary>{f.q}</summary><p>{f.a}</p></details>)}
      </section>
    </main>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(compareJsonLd()).replace(/</g, "\\u003c") }} />
  </div>;
}
