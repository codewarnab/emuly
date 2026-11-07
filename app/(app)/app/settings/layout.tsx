import { Suspense } from "react";
import { requireUser } from "../../../../lib/auth";
import { Topbar, Avatar } from "../../../../components/topbar";
import { SettingsTabs } from "../../../../components/settings-tabs";
import { SettingsProvider } from "../../../../components/settings-provider";
import { KeyboardTools } from "../../../../components/keyboard-tools";
import { listPhones } from "../../../../lib/phones";
import { db } from "../../../../lib/db";
import { chosenPlan, userSettings } from "../../../../lib/settings";
import s from "../../../../components/console.module.css";

// Keep the shared controls mounted when switching settings tabs.
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div className={s.skeletonLine} />}><SettingsShell>{children}</SettingsShell></Suspense>;
}
async function SettingsShell({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const settings = userSettings(db(), user.id);
  const override = db().prepare("SELECT allowance_override FROM billing_settings WHERE user_id = ?").get(user.id);
  const plan = override?.allowance_override != null ? "custom" : chosenPlan(db(), user.id) ?? "free";
  return <>
    <Topbar nav={[{ label: "Phones" }, { label: "Settings", on: true }]}>
      <Avatar initials={user.initials} login={user.login} />
    </Topbar>
    <main className={s.pagewrap} id="main-content" tabIndex={-1}>
      <div className={s.pagehead}><h1>Settings</h1></div>
      <SettingsTabs />
      <SettingsProvider initial={{ idle: settings.default_idle_min, autoStop: settings.auto_stop_before_empty,
        autoKeep: settings.auto_keep, plan, allowance: settings.allowance_core_hours }}>
        <KeyboardTools phones={listPhones(user.id).map(phone => ({ id: phone.id, name: phone.id }))} />
        <Suspense fallback={<div className={s.skeletonLine} />}>{children}</Suspense>
      </SettingsProvider>
    </main>
  </>;
}
