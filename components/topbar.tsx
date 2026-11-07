import Link from "next/link";
import { CommandHint } from "./keyboard-tools";
import s from "./console.module.css";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./button";

export function Brand() {
  return (
    <Link href="/" className={s.brand}>
      <span className={s.dot} />
      phonelink
    </Link>
  );
}

export function Avatar({ initials, login }: { initials: string; login: string }) {
  return <details className={s.userMenu}>
    <summary aria-label={`Account: ${login}`}><span className={s.avatar}>{initials}</span></summary>
    <div className={s.menuContent}>
      <p>Signed in as <b>{login}</b></p>
      <Link href="/app/settings/hours">Settings → Hours</Link>
      <Link href="/app/settings/webhooks">Settings → Webhooks</Link>
      <form action="/auth/logout" method="post">
        <Button variant="ghost" tiny type="submit">Log out</Button>
      </form>
    </div>
  </details>;
}

export function Topbar({
  nav,
  breadcrumb,
  children,
}: {
  /** main nav labels; "on" marks the active one */
  nav?: Array<{ label: string; on?: boolean }>;
  /** breadcrumb on phone pages: ["Phones", "phone-7f2a"] */
  breadcrumb?: string[];
  /** right side (quota chip, pill, buttons, avatar) */
  children: React.ReactNode;
}) {
  return (
    <header className={s.topbar}>
      <Brand />
      {nav && (
        <nav className={s.topnav} aria-label="Main">
          {nav.map((n) => (
            <Link href={n.label === "Phones" ? "/app" : n.label === "Usage" ? "/app#usage" : n.label === "Settings" ? "/app/settings/hours" : "/app#phones"} key={n.label} className={n.on ? s.on : ""}>
              {n.label}
            </Link>
          ))}
        </nav>
      )}
      {breadcrumb && (
        <nav className={`${s.topnav} ${s.crumb}`} aria-label="Breadcrumb">
          <Link href="/app">Phones</Link>
          <span>/</span>
          <span className={s.on} aria-current="page">{breadcrumb[breadcrumb.length - 1]}</span>
        </nav>
      )}
      <div className={s.spacer} />
      <CommandHint />
      <ThemeToggle />
      {children}
    </header>
  );
}
