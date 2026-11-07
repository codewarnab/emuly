import { Suspense } from "react";
import Link from "next/link";
import { requireUser } from "../../../../../lib/auth";
import { db } from "../../../../../lib/db";
import { userSettings } from "../../../../../lib/settings";
import { phoneCreationOptions } from "../../../../actions/phones";
import { Topbar, Avatar } from "../../../../../components/topbar";
import { HoursSettings } from "../../../../../components/hours-settings";
import { readAccountUsage } from "../../../../../lib/billing";
import { ConsoleLoading } from "../../../../../components/console-loading";
import s from "../../../../../components/console.module.css";

export default function HoursPage() {
  return <Suspense fallback={<ConsoleLoading />}><Hours /></Suspense>;
}

async function Hours() {
  const user = await requireUser();
  await readAccountUsage(user);
  const options = await phoneCreationOptions();
  return <>
    <Topbar nav={[{ label: "Phones" }, { label: "Settings", on: true }]}>
      <Avatar initials={user.initials} login={user.login} />
    </Topbar>
    <main className={s.pagewrap} id="main-content" tabIndex={-1}>
      <div className={s.pagehead}><div><h1>Hours</h1><p>Settings for your shared hours budget and new phones.</p></div></div>
      <p>Hours / <Link href="/app/settings/webhooks">Webhooks</Link></p>
      <HoursSettings settings={userSettings(db(), user.id)} machines={options.machines} message={options.message} />
    </main>
  </>;
}
