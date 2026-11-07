import Link from "next/link";
import { requireUser } from "../../../../../lib/auth";
import { webhookControl } from "../../../../../lib/webhook-control";
import { WebhookSettings } from "../../../../../components/webhook-settings";
import s from "../../../../../components/console.module.css";

export default async function WebhooksPage() {
  const user = await requireUser();
  const service = webhookControl();
  const hooks = service.list(user.id);
  const recent = Object.fromEntries(hooks.map(hook => [hook.id, service.deliveries(user.id, hook.id).slice(0, 5)]));
  return <>
    <p className={s.settingHint}>Send phone events to your tools. <Link href="/app/settings/webhooks/docs">Docs</Link></p>
    <WebhookSettings initial={hooks} recent={recent} />
  </>;
}
