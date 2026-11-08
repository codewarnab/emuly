import Link from "next/link";
import { Brand } from "@/components/shell/topbar";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import s from "./not-found.module.css";

export default function NotFound() {
  return (
    <div className={s.page}>
      <header className={s.header}>
        <Brand />
        <ThemeToggle />
      </header>
      <main id="main-content" tabIndex={-1} className={s.main}>
        <div className={s.art} aria-hidden="true">
          <div className={s.orbit} />
          <span className={s.four}>4</span>
          <div className={s.phone}>
            <div className={s.screen}>
              <span className={s.camera} />
              <svg viewBox="0 0 64 64" fill="none" className={s.signal}>
                <path d="M10 22a34 34 0 0 1 44 0M18 32a22 22 0 0 1 28 0M26 42a10 10 0 0 1 12 0" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                <circle cx="32" cy="51" r="3" fill="currentColor" />
                <path d="m13 10 38 46" stroke="var(--screen)" strokeWidth="9" />
                <path d="m13 10 38 46" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
              <span className={s.screenLabel}>PAGE NOT FOUND</span>
              <span className={s.homeIndicator} />
            </div>
          </div>
          <span className={s.four}>4</span>
          <span className={s.sparkOne}>+</span>
          <span className={s.sparkTwo}>+</span>
          <span className={s.dot} />
        </div>
        <p className={s.eyebrow}>ERROR 404 · A LITTLE OFF THE MAP</p>
        <h1>This link leads nowhere.</h1>
        <p className={s.description}>
          The page may have moved, or this phone is no longer here.
          <br className={s.lineBreak} /> Let’s get you back to familiar ground.
        </p>
        <nav className={s.actions} aria-label="Find your way back">
          <Link href="/app" className={s.primary}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m12 5-7 7 7 7M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back to my phones
          </Link>
          <Link href="/" className={s.secondary}>Go to homepage <span aria-hidden="true">↗</span></Link>
        </nav>
        <p className={s.hint}>Following a saved link? Check that you copied the whole address.</p>
      </main>
      <footer className={s.footer}>Your codespace. Your phone. Your way back.</footer>
    </div>
  );
}
