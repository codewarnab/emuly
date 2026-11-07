import Loading from "./loading";
import { Suspense } from "react";
import { requireUser } from "../../../lib/auth";
import { listPhones, phoneCard } from "../../../lib/phones";
import { EmptyState } from "../../../components/empty-state";
import s from "../../../components/console.module.css";
import { PhoneCollection } from "../../../components/phone-collection";
import { QuotaStrip } from "../../../components/quota-strip";
import { NewPhone, PhoneRefresh, StopAll } from "../../../components/phone-mutations";
import { syncPhoneState } from "../../../lib/phone-control";
import { Topbar, Avatar } from "../../../components/topbar";
import { db } from "../../../lib/db";
import { readUsage, userSettings } from "../../../lib/usage";
import { readAccountUsage } from "../../../lib/billing";
import { KeyboardTools } from "../../../components/keyboard-tools";
import { hoursWarning } from "../../../lib/hours";
import { retentionStatus } from "../../../lib/retention";

/** Dashboard: each phone is a codespace in the signed-in user's account. */
export default function DashboardPage() {
  return <Suspense fallback={<Loading />}><Dashboard /></Suspense>;
}

async function Dashboard({ clock = Date.now }: { clock?: () => number }) {
  const user = await requireUser();
  const syncError = await syncPhoneState(user.id);
  const phones = listPhones(user.id);
  const usage = await readAccountUsage(user, clock);
  const settings = userSettings(db(), user.id);
  const warning = hoursWarning(readUsage(db(), user.id, clock), settings.auto_stop_before_empty);
  const defaultCores = phones.find(phone => phone.machine === settings.default_machine)?.cores
    ?? (settings.default_machine === "basicLinux32gb" ? 2 : 4);
  const now = clock();
  const cards = phones.map(phone => ({ card: phoneCard(phone), state: phone.keeping ? "keeping" : phone.state,
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
      <main className={s.pagewrap} id="main-content" tabIndex={-1}>
      <div className={s.pagehead}>
        <div>
          <h1>Your phones</h1>
          <p>
            Running phones share your hours. Each one is a codespace in{" "}
            <span>
              {user.login}
            </span>
            &apos;s account.
          </p>
        </div>
        <div className={s.acts}><StopAll count={usage.running.length} /><NewPhone usage={usage} /></div>
      </div>
      {syncError && <p role="status">{syncError}</p>}
      {warning && <p role="status" className={s.hoursBanner}>{warning}</p>}
      {cards.some(phone => phone.retention?.warning) && <p role="status" className={s.hoursBanner}>
        GitHub deletes some stopped phones in less than 2 days. Choose Keep it to reset their countdown.
      </p>}
      <PhoneRefresh />
      <KeyboardTools phones={phones.map(phone => ({ id: phone.id, name: phone.id }))} />
      <QuotaStrip usage={usage} defaultCores={defaultCores} />

      {phones.length === 0 ? (
        <EmptyState title="No phones yet"
          sub="Choose New phone to create a codespace in your own GitHub account." />
      ) : (
        <PhoneCollection userId={user.id} phones={cards} />
      )}
      <div className={s.fineprint}>
        <span>Stopping keeps the phone.</span>
        <span>Only deleting the codespace erases it.</span>
        <span>Running phones share your hours.</span>
        <span>GitHub stops an idle phone after 30 minutes or 4 hours, your choice.</span>
      </div>
    </main>
    </>
  );
}
