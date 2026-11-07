import { ConsoleLoading } from "../../components/console-loading";
import Link from "next/link";
import { KeyboardTools } from "../../components/keyboard-tools";
import { listPhones } from "../../lib/phones";
import { mockDetail } from "../../components/fixtures";
import { Suspense } from "react";
import { requireUser } from "../../lib/auth";
import s from "../../components/console.module.css";

/** Console shell wrapper + mobile tabbar (board 05).
    Topbars are rendered per page (dashboard nav vs phone breadcrumb). */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<ConsoleLoading />}><AuthenticatedShell>{children}</AuthenticatedShell></Suspense>;
}

async function AuthenticatedShell({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const phones = listPhones(user.id).map(phone => ({ id: phone.id, name: phone.id, ...(process.env.PHONELINK_MOCK === "1" && phone.id === mockDetail.phone ? { stream: mockDetail.streamUrl, adb: mockDetail.thisPhone.find(([key]) => key === "adb")?.[1] } : {}) }));
  return (
    <div className={s.app}>
      <KeyboardTools phones={phones} />
      {children}
      <nav className={s.tabbar} aria-label="Console">
        <Link href="/app" className={s.tabOn}>Phones</Link>
        
        <Link href="/app#usage">Usage</Link>
      </nav>
    </div>
  );
}
