import Loading from "./loading";
import { Suspense } from "react";
import { requireUser } from "../../../lib/auth/auth";
import { listPhones, phoneCard } from "../../../lib/phone/phones";
import { EmptyPhones } from "@/components/phone/empty-phones";
import s from "../../../components/console.module.css";
import { PhoneCollection } from "@/components/phone/phone-collection";
import { QuotaStrip } from "@/components/shell/quota-strip";
import { NewPhone, PhoneRefresh, StopAll } from "@/components/phone/phone-mutations";
import { syncPhoneState } from "../../../lib/phone/phone-control";
import { SyncNotice } from "@/components/shell/sync-notice";
import { Topbar, Avatar } from "@/components/shell/topbar";
import { asyncDb } from "../../../lib/data/async-db";
import { readUsage, userSettings } from "../../../lib/data/usage";
import { readAccountUsage } from "../../../lib/github/billing";
import { chosenPlan } from "../../../lib/data/settings";
import { redirect } from "next/navigation";
import { KeyboardTools } from "@/components/shell/keyboard-tools";
import { hoursWarning } from "../../../lib/shared/hours";
import { retentionStatus } from "../../../lib/data/retention";

/** Dashboard: each phone is a codespace in the signed-in user's account. */
export default function DashboardPage() {
  return <Suspense fallback={<Loading />}><Dashboard /></Suspense>;
}

async function Dashboard({ clock = Date.now }: { clock?: () => number }) {
  const user = await requireUser();
  if (!(await chosenPlan(asyncDb(), user.id))) redirect("/app/welcome");
  const syncError = await syncPhoneState(user.id);
  const phones = listPhones(user.id);
  const usage = await readAccountUsage(user, clock);
  const settings = await userSettings(asyncDb(), user.id);
  const warning = hoursWarning(await readUsage(asyncDb(), user.id, clock), settings.auto_stop_before_empty);
  const defaultCores = 4;
  const now = clock();
  const cards = phones.map(phone => ({ card: phoneCard(phone), state: phone.keeping ? "keeping" : phone.state,
    codespace: phone.codespace_name.startsWith("pending:") ? null : phone.codespace_name,
    lastUsed: phone.last_started_at, retention: retentionStatus(phone, () => now) }));
  return (
    <>
      <Topbar
        nav={[
          { label: "Phones", on: true },
          { label: "Settings" },
        ]}
      >
        <Avatar initials={user.initials} login={user.login} />
      </Topbar>
      <main className={`${s.pagewrap} ${s.dashWrap}`} id="main-content" tabIndex={-1}>
      <div className={s.pagehead}>
        <h1>Your phones</h1>
        {phones.length > 0 && <div className={s.acts}><StopAll count={usage.running.length} /><NewPhone usage={usage} /></div>}
      </div>
      {syncError && <SyncNotice error={syncError} />}
      {warning && <p role="status" className={s.hoursBanner}>{warning}</p>}
      {cards.some(phone => phone.retention?.warning) && <p role="status" className={s.hoursBanner}>
        GitHub deletes some stopped phones in less than 2 days. Choose Keep it to reset their countdown.
      </p>}
      {(!syncError || syncError.kind === "other") && <PhoneRefresh />}
      <KeyboardTools phones={phones.map(phone => ({ id: phone.id, name: phone.name }))} />
      <QuotaStrip usage={usage} defaultCores={defaultCores} />

      {phones.length === 0 ? (
        <EmptyPhones usage={usage} />
      ) : (
        <PhoneCollection userId={user.id} phones={cards} />
      )}
      <ul className={s.facts} aria-label="Good to know">
        <li><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/></svg>Stop keeps your phone</li>
        <li><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/></svg>Only Delete erases it</li>
        <li><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8.5" r="5"/><path d="M8 6v2.5l1.8 1.2"/></svg>Idle phones stop on their own</li>
        <li><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"/><path d="M5.5 8.5c1 1.2 4 1.2 5 0"/></svg>Runs in {user.login}&apos;s GitHub</li>
      </ul>
    </main>
    </>
  );
}
