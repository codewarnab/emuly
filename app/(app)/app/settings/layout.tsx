import { Suspense } from "react";
import { requireUser } from "../../../../lib/auth/auth";
import { Topbar, Avatar } from "@/components/shell/topbar";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { SettingsProvider } from "@/components/settings/settings-provider";
import { KeyboardTools } from "@/components/shell/keyboard-tools";
import { listPhones } from "../../../../lib/phone/phones";
import { asyncDb } from "../../../../lib/data/async-db";
import { userSettings } from "../../../../lib/data/settings";
import s from "../../../../components/console.module.css";

// Keep the shared controls mounted when switching settings tabs.
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div className={s.skeletonLine} />}><SettingsShell>{children}</SettingsShell></Suspense>;
}
async function SettingsShell({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const database = asyncDb();
  const [settings, billing, phones] = await Promise.all([
    userSettings(database, user.id),
    database.execute({ sql: "SELECT plan_name, allowance_override FROM billing_settings WHERE user_id = ?", args: [user.id] }),
    listPhones(user.id),
  ]);
  const selected = billing.rows[0];
  const plan = selected?.allowance_override != null ? "custom" : selected?.plan_name === "pro" ? "pro" : "free";
  return <>
    <Topbar nav={[{ label: "Phones" }, { label: "Settings", on: true }]}>
      <Avatar initials={user.initials} login={user.login} avatarUrl={user.avatarUrl} />
    </Topbar>
    <main className={s.pagewrap} id="main-content" tabIndex={-1}>
      <div className={s.pagehead}><h1>Settings</h1></div>
      <SettingsTabs />
      <SettingsProvider initial={{ idle: settings.default_idle_min, autoStop: settings.auto_stop_before_empty,
        autoKeep: settings.auto_keep, plan, allowance: settings.allowance_core_hours }}>
        <KeyboardTools phones={phones.map(phone => ({ id: phone.id, name: phone.name }))} />
        <Suspense fallback={<div className={s.skeletonLine} />}>{children}</Suspense>
      </SettingsProvider>
    </main>
  </>;
}
