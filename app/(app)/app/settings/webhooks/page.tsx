import { Suspense } from "react";
import Link from "next/link";
import { requireUser } from "../../../../../lib/auth";
import { webhookControl } from "../../../../../lib/webhook-control";
import { Topbar, Avatar } from "../../../../../components/topbar";
import { WebhookSettings } from "../../../../../components/webhook-settings";
import { ConsoleLoading } from "../../../../../components/console-loading";
import s from "../../../../../components/console.module.css";

export default function WebhooksPage() {
  return <Suspense fallback={<ConsoleLoading />}><Webhooks /></Suspense>;
}

async function Webhooks() {
  const user = await requireUser();
  return <>
    <Topbar nav={[{ label: "Phones" }, { label: "Settings", on: true }]}>
      <Avatar initials={user.initials} login={user.login} />
    </Topbar>
    <main className={s.pagewrap} id="main-content" tabIndex={-1}>
      <div className={s.pagehead}><div><h1>Webhooks</h1><p>Send phone, hours and retention events to your tools.</p></div></div>
      <p><Link href="/app/settings/hours">Hours</Link> / Webhooks / <Link href="/app/settings/webhooks/docs">Delivery documentation</Link></p>
      <WebhookSettings initial={webhookControl().list(user.id)} />
    </main>
  </>;
}
