import { KeyboardTools } from "@/components/shell/keyboard-tools";
import { HeroPhone } from "@/components/marketing/hero-phone";
import { Topbar } from "@/components/shell/topbar";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getUser } from "../../lib/auth/auth";
import { safeNext } from "../../lib/auth/next-path";
import s from "../../components/console.module.css";

type Props = { searchParams: Promise<{ error?: string | string[]; next?: string | string[] }> };

export default function LoginPage(props: Props) {
  return <Suspense fallback={<main className={`${s.app} ${s.login}`} aria-label="Loading sign-in" />}>
    <LoginContent {...props} />
  </Suspense>;
}

async function LoginContent({ searchParams }: Props) {
  const { error, next } = await searchParams;
  const destination = safeNext(next);
  if (await getUser()) redirect(destination ?? "/app");
  return (
    <>
    <KeyboardTools /><Topbar>{null}</Topbar>
    <main className={`${s.app} ${s.login}`} id="main-content" tabIndex={-1}>
      <section className={s.loginText}>
        <h1 className={s.loginH}>Sign in</h1>
        <p className={s.loginSub}>Your phones run in your own GitHub account.</p>
        <a className={s.gh} href={destination ? `/auth/start?next=${encodeURIComponent(destination)}` : "/auth/start"}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          Continue with GitHub
        </a>
        {error && <p className={s.loginError} role="alert">
          {error === "scope"
            ? "GitHub did not grant the codespace permission. Try again and approve it."
            : "Sign-in failed. Try again."}
        </p>}
        <p className={s.loginFoot}>
          Codespaces access only. No repo access.{" "}
          <a href="https://github.com/settings/applications" className={s.link} target="_blank" rel="noopener noreferrer">Revoke</a>
        </p>
      </section>
      <div className={s.loginDevice}><HeroPhone /></div>
    </main>
    </>
  );
}
