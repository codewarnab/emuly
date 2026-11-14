import { Suspense } from "react";
import { requireUser } from "../../../../../../lib/auth/auth";
import { asyncDb } from "../../../../../../lib/data/async-db";
import { getPhoneDeleteRequestByToken, type PhoneDeleteRequest } from "../../../../../../lib/data/phone-deletions";
import { runnerApps } from "../../../../../../lib/phone/phone-runner";
import { findPhone, type Phone } from "../../../../../../lib/phone/phones";
import { DeleteRequestView } from "@/components/phone/delete-request-view";
import { KeyboardTools } from "@/components/shell/keyboard-tools";
import { Topbar } from "@/components/shell/topbar";
import { DeletePhoneArt } from "@/components/phone/delete-phone-art";
import s from "@/components/link/link.module.css";

export const metadata = { title: "Delete phone — Emuly" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ request?: string | string[] }>;
};

export default function DeletePhonePage(props: Props) {
  return <Suspense fallback={<main className={s.page} aria-label="Loading deletion request" />}>
    <DeletePhoneContent {...props} />
  </Suspense>;
}

async function DeletePhoneContent({ params, searchParams }: Props) {
  const user = await requireUser();
  const { id } = await params;
  const { request: raw } = await searchParams;
  const rawToken = Array.isArray(raw) ? raw[0] : raw;
  const request = rawToken ? await getPhoneDeleteRequestByToken(asyncDb(), rawToken, user.id) : null;
  const phone = request ? await findPhone(user.id, request.phoneId) : undefined;
  const apps = phone ? await installedCount(user.id, phone) : null;
  return (
    <>
      <KeyboardTools />
      <Topbar breadcrumb={phone ? ["Phones", phone.name] : ["Phones"]}>{null}</Topbar>
      <main className={s.page} id="main-content" tabIndex={-1}>
        <section className={s.text} aria-labelledby="delete-title">
          {user.authKind === "agent"
            ? <State eyebrow="Browser only" title="Open this link in a browser" state="denied"
                message="Agent keys cannot approve a phone deletion. Ask the user to open the link." />
            : <DeleteState request={request} token={rawToken} phone={phone} apps={apps} />}
        </section>
        <div className={s.device}><DeletePhoneArt name={phone?.name ?? "your phone"} /></div>
      </main>
    </>
  );
}

async function installedCount(userId: number, phone: Phone) {
  if (phone.state !== "running" || phone.android_state !== "ready") return null;
  try {
    const response = await runnerApps(userId, phone.id, "/apps", { method: "GET" });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    const apps = value && typeof value === "object" ? (value as Record<string, unknown>).apps : undefined;
    return Array.isArray(apps) ? apps.length : null;
  } catch { return null; }
}

function State({ eyebrow, title, message, state }: { eyebrow: string; title: string; message: string; state: string }) {
  return <>
    <p className={s.eyebrow} data-state={state}>{eyebrow}</p>
    <h1 id="delete-title" className={s.title}>{title}</h1>
    <p className={s.sub}>{message}</p>
  </>;
}

function DeleteState({ request, token, phone, apps }: {
  request: PhoneDeleteRequest | null; token?: string; phone?: Phone; apps: number | null;
}) {
  if (!request) {
    return <State eyebrow="Deletion link" title="This link is not valid" state="expired"
      message="Ask your agent for a new deletion link." />;
  }
  if (request.status === "done" || (request.status === "pending" && !phone)) {
    return <State eyebrow="Deleted" title="Phone deleted" state="deleted"
      message="The codespace and its data are gone. Your agent will see the result on its next check." />;
  }
  if (request.status === "denied") {
    return <State eyebrow="Kept" title="Phone kept" state="kept"
      message={`${phone?.name ?? "This phone"} was not deleted.`} />;
  }
  if (request.status === "expired") {
    return <State eyebrow="Expired" title="This request expired" state="expired"
      message="Deletion links last 10 minutes. Ask your agent for a new one." />;
  }
  if (request.status === "approved") {
    return <State eyebrow="Deleting" title="Deletion in progress" state="deleted"
      message="The phone is being removed. Refresh in a moment." />;
  }
  if (!phone || !token) {
    return <State eyebrow="Deletion link" title="This link is not valid" state="expired"
      message="Ask your agent for a new deletion link." />;
  }
  return <DeleteRequestView token={token} name={phone.name} state={phone.state} apps={apps} />;
}
