import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { KeyboardTools } from "@/components/shell/keyboard-tools";
import { Topbar } from "@/components/shell/topbar";
import { HeroPhone } from "@/components/marketing/hero-phone";
import { getUser } from "@/lib/auth/auth";
import { asyncDb } from "@/lib/data/async-db";
import { getDeviceRequest, type DeviceRequest, type DeviceRequestStatus } from "@/lib/data/agents";
import { chosenPlan } from "@/lib/data/settings";
import { DeviceActions } from "@/components/link/device-actions";
import { timeAgo, utcLabel } from "@/lib/shared/relative-time";
import s from "@/components/link/link.module.css";

export const metadata = { title: "Connect your agent — Emuly" };

type Props = { searchParams: Promise<{ code?: string | string[] }> };

export default function LinkPage(props: Props) {
  return <Suspense fallback={<main className={s.page} aria-label="Loading sign-in" />}>
    <LinkContent {...props} />
  </Suspense>;
}

async function LinkContent({ searchParams }: Props) {
  const { code } = await searchParams;
  const raw = Array.isArray(code) ? code[0] : code;
  const returnTo = raw ? `/link?code=${encodeURIComponent(raw)}` : "/link";
  const user = await getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  const request = raw ? await getDeviceRequest(asyncDb(), raw) : null;
  // A new user chooses a GitHub plan before approving, so phone hours are right from the start.
  if (request?.status === "pending" && !(await chosenPlan(asyncDb(), user.id))) {
    redirect(`/app/welcome?next=${encodeURIComponent(returnTo)}`);
  }
  return (
    <>
      <KeyboardTools /><Topbar>{null}</Topbar>
      <main className={s.page} id="main-content" tabIndex={-1}>
        <section className={s.text} aria-labelledby="link-title">
          {request
            ? <DeviceState request={request} login={user.login} />
            : <CodeEntry value={raw} invalid={Boolean(raw)} />}
        </section>
        <div className={s.device}><HeroPhone /></div>
      </main>
    </>
  );
}

function Code({ value }: { value: string }) {
  const [left, right = ""] = value.split("-");
  const cells = (part: string) => Array.from(part).map((char, index) => <span key={index} className={s.cell}>{char}</span>);
  return <p className={s.code} aria-label={`Code ${value.split("").join(" ")}`}>
    <span className={s.group}>{cells(left)}</span>
    <span className={s.dash} aria-hidden="true">–</span>
    <span className={s.group}>{cells(right)}</span>
  </p>;
}

function Footer({ login, createdAt }: { login: string; createdAt: string }) {
  return <>
    <p className={s.foot}>
      Signed in as <strong>{login}</strong>
      <span aria-hidden="true"> · </span>
      <time dateTime={createdAt} title={utcLabel(createdAt)}>Requested {timeAgo(createdAt, Date.now())}</time>
    </p>
    <p className={s.console}><Link href="/app">Go to console <span aria-hidden="true">→</span></Link></p>
  </>;
}

const DONE: Record<Exclude<DeviceRequestStatus, "pending">, { eyebrow: string; title: string; message: string }> = {
  approved: { eyebrow: "Connected", title: "You're connected", message: "Go back to your agent. It continues on its own." },
  used: { eyebrow: "Connected", title: "You're connected", message: "This code was already used. Go back to your agent." },
  denied: { eyebrow: "Denied", title: "Request denied", message: "Your agent was not connected. Ask it for a new link to try again." },
  expired: { eyebrow: "Expired", title: "This code expired", message: "Codes last 10 minutes. Ask your agent for a new link." },
};

function DeviceState({ request, login }: { request: DeviceRequest; login: string }) {
  if (request.status !== "pending") {
    const state = DONE[request.status];
    return <>
      <p className={s.eyebrow} data-state={request.status}>{state.eyebrow}</p>
      <h1 id="link-title" className={s.title}>{state.title}</h1>
      <p className={s.sub}>{state.message}</p>
      <Footer login={login} createdAt={request.createdAt} />
    </>;
  }
  return <>
    <p className={s.eyebrow}>Agent sign-in</p>
    <h1 id="link-title" className={s.title}>Connect your agent</h1>
    <p className={s.sub}>Check that this code matches the one in your agent chat.</p>
    <Code value={request.userCode} />
    <ul className={s.scope}>
      <li data-kind="can">List, start, stop, and control your phones</li>
      <li data-kind="cannot">Delete phones, change settings, or edit webhooks</li>
    </ul>
    <DeviceActions code={request.userCode} />
    <Footer login={login} createdAt={request.createdAt} />
  </>;
}

function CodeEntry({ value, invalid }: { value?: string; invalid: boolean }) {
  return <>
    <p className={s.eyebrow}>Agent sign-in</p>
    <h1 id="link-title" className={s.title}>Enter your code</h1>
    <p className={s.sub}>Your agent shows the code in its chat. It lasts 10 minutes.</p>
    <form action="/link" method="get" className={s.form}>
      <label className={s.srOnly} htmlFor="code">Sign-in code</label>
      <input className={s.input} id="code" name="code" defaultValue={value ?? ""} placeholder="ABCD-2345"
        autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} maxLength={12} autoFocus
        aria-invalid={invalid || undefined} aria-describedby={invalid ? "code-error" : undefined} />
      <button type="submit" className={s.primary}>Continue</button>
    </form>
    {invalid && <p id="code-error" className={s.error} role="alert">That code does not match a sign-in request.</p>}
  </>;
}
