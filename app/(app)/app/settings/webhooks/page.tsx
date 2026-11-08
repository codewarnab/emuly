import Link from "next/link";
import { Suspense } from "react";
import { requireUser } from "../../../../../lib/auth/auth";
import { webhookControl } from "../../../../../lib/webhooks/webhook-control";
import { WebhookSettings } from "@/components/settings/webhook-settings";
import s from "../../../../../components/console.module.css";

export default function WebhooksPage() {
  return <>
    <p className={s.settingHint}>Send phone events to your tools. <Link href="/app/settings/webhooks/docs">Docs</Link></p>
    <Suspense fallback={<WebhooksSkeleton />}>
      <WebhooksContent />
    </Suspense>
  </>;
}

function WebhooksSkeleton() {
  return <div role="status" aria-label="Loading webhooks" className={s.webhooks}>
    <div aria-hidden="true">
      <div className={s.skeletonLine} style={{ width: 100, height: 16, marginBottom: 8 }} />
      <div className={s.webhookAddRow}>
        <div className={s.skeletonRow} style={{ flex: 1, height: 38, marginTop: 0 }} />
        <div className={s.skeletonRow} style={{ width: 64, height: 38, marginTop: 0 }} />
      </div>
      <div className={s.skeletonLine} style={{ width: 120, height: 16, marginTop: 16, marginBottom: 0 }} />
    </div>
    <div aria-hidden="true" className={s.webhookEndpoint}>
      <div className={s.skeletonLine} style={{ width: "min(320px, 80%)" }} />
      <div className={s.skeletonRow} style={{ width: 88, height: 28, marginTop: 12 }} />
      <div className={s.skeletonLine} style={{ width: 144, height: 12, marginTop: 16, marginBottom: 0 }} />
    </div>
  </div>;
}

async function WebhooksContent() {
  const user = await requireUser();
  const service = webhookControl();
  const hooks = service.list(user.id);
  const recent = Object.fromEntries(hooks.map(hook => [hook.id, service.deliveries(user.id, hook.id).slice(0, 5)]));
  return <WebhookSettings initial={hooks} recent={recent} />;
}
