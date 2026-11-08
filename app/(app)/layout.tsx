import { ConsoleLoading } from "@/components/ui/console-loading";
import Link from "next/link";
import { Suspense } from "react";
import { requireUser } from "../../lib/auth/auth";
import s from "../../components/console.module.css";
import { asyncDb } from "../../lib/data/async-db";
import { unreadAutoStops } from "../../lib/shared/hours";
import { AutoStopNotice } from "@/components/shell/auto-stop-notice";
import { webhookControl } from "../../lib/webhooks/webhook-control";

/** Console shell wrapper + mobile tabbar (board 05).
    Topbars are rendered per page (dashboard nav vs phone breadcrumb). */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<ConsoleLoading />}><AuthenticatedShell>{children}</AuthenticatedShell></Suspense>;
}

async function AuthenticatedShell({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const disabledWebhooks = (await webhookControl().list(user.id)).filter(hook => !hook.enabled && hook.failing_since);
  return (
    <div className={s.app}>
      <AutoStopNotice notices={await unreadAutoStops(asyncDb(), user.id)} />
      {disabledWebhooks.length > 0 && <aside className={s.hoursBanner} role="status">
        {disabledWebhooks.length} webhook endpoint{disabledWebhooks.length === 1 ? " is" : "s are"} disabled after 3 days of only failures.{" "}
        <Link href="/app/settings/webhooks">Review Webhooks</Link>
      </aside>}
      {children}
      <nav className={s.tabbar} aria-label="Console">
        <Link href="/app" className={s.tabOn}>Phones</Link>
        
        <Link href="/app#usage">Usage</Link>
        <Link href="/app/settings/hours">Hours</Link>
      </nav>
    </div>
  );
}
