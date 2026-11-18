import Link from "next/link";
import { CommandHint } from "@/components/shell/keyboard-tools";
import s from "@/components/console.module.css";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { UserMenu } from "@/components/shell/user-menu";

export function Brand() {
  return (
    <Link href="/" className={s.brand}>
      <svg className={s.dot} viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="var(--accent)" /><rect x="19" y="10" width="26" height="44" rx="7" fill="var(--on-accent)" /><path d="M32 20.5Q33.6 30.4 41.5 32Q33.6 33.6 32 43.5Q30.4 33.6 22.5 32Q30.4 30.4 32 20.5Z" fill="var(--accent)" /></svg>
      Emuly
    </Link>
  );
}

export function Avatar({ initials, login, avatarUrl }: { initials: string; login: string; avatarUrl?: string | null }) {
  return <UserMenu initials={initials} login={login} avatarUrl={avatarUrl} />;
}

export function Topbar({
  nav,
  breadcrumb,
  children,
}: {
  /** main nav labels; "on" marks the active one */
  nav?: Array<{ label: string; on?: boolean }>;
  /** breadcrumb on phone pages: ["Phones", "phone-quiet-falcon"] */
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
