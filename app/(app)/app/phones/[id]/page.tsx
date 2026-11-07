import { PHONE_TABS } from "../../../../../lib/keyboard";
import { idleLabel } from "../../../../../lib/idle";
import Loading from "./loading";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireUser } from "../../../../../lib/auth";
import { findPhone, listPhones, phoneCard, phoneEvents, type Phone } from "../../../../../lib/phones";
import { KeyboardTools } from "../../../../../components/keyboard-tools";
import { syncPhoneState } from "../../../../../lib/phone-control";
import { PhoneMutation, PhoneRefresh } from "../../../../../components/phone-mutations";
import s from "../../../../../components/console.module.css";
import { Topbar, Avatar } from "../../../../../components/topbar";
import { Stage } from "../../../../../components/stage";
import { Tabs, type Tab } from "../../../../../components/tabs";
import { LogFeed } from "../../../../../components/log-feed";
import { Mini, UrlRow } from "../../../../../components/mini";
import { DangerPanel } from "../../../../../components/danger-panel";
import { Button } from "../../../../../components/button";
import { Pill } from "../../../../../components/pill";
import { mockLog, mockDetail, mockPhones } from "../../../../../components/fixtures";

/** Board block 03 — the live screen. Stage left, log right, tabs on top.
    Also board 04: the Danger tab holds the one destructive action. */

const tabSet = new Set<string>(PHONE_TABS);

async function TabPanel({ phoneId, search }: { phoneId: string; search: Promise<{ tab?: string }> }) {
  const { tab: rawTab } = await search;
  const tab = (rawTab && tabSet.has(rawTab) ? rawTab : "log") as Tab;
  const phone = mockPhones[0]!;

  return (
    <>
      <Tabs active={tab} phoneId={phoneId} />

      <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
      {tab === "log" && (
        <>
          <LogFeed title={`Activity for ${mockLog.phone}`} rows={mockLog.rows} />
          <UrlRow url={mockDetail.streamUrl} />
          <div className={s.subgrid}>
            <Mini title="This phone" rows={mockDetail.thisPhone} />
            <Mini title="Last backup" rows={mockDetail.lastBackup} />
          </div>
        </>
      )}

      {tab === "apps" && (
        <LogFeed title={`Installed apps for ${phone.name}`} rows={[]} live={false} emptyMessage="No apps listed. Installed packages will appear when this phone connects." />
      )}

      {tab === "backups" && (
        <LogFeed title={`Backups for ${phone.name}`} rows={[]} live={false} emptyMessage="No named backups yet. Backups are opt-in. Stopping still keeps the phone and its snapshot." />
      )}

      {tab === "danger" && <DangerPanel phoneName={phone.name} />}
      </section>
    </>
  );
}

async function PhoneContent({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  let phone = findPhone(user.id, id);
  const mock = process.env.PHONELINK_MOCK === "1" && id === "phone-7f2a";
  if (!phone && !mock) notFound();
  if (!mock && phone) {
    const syncError = await syncPhoneState(user.id);
    phone = findPhone(user.id, id);
    if (!phone) notFound();
    return <StoredPhone phone={phone} user={user} search={searchParams} syncError={syncError} />;
  }

  return (
    <>
      <KeyboardTools phones={listPhones(user.id).map(item => ({ id: item.id, name: item.id,
        ...(item.id === mockDetail.phone ? { stream: mockDetail.streamUrl, adb: mockDetail.thisPhone.find(([key]) => key === "adb")?.[1] } : {}),
      }))} />
      <Topbar breadcrumb={["Phones", mockDetail.phone]}>
        <Pill kind={mockDetail.state}>
          running <span className={s.upTxt}>for {mockDetail.upFor}</span>
        </Pill>
        <Button variant="ghost" tiny disabled aria-describedby="phone-control-note">
          Stop
        </Button>
        <span id="phone-control-note" className={s.srOnly}>Phone controls are not connected yet.</span>
        <Avatar initials={user.initials} login={user.login} />
      </Topbar>

      <main className={s.detail} id="main-content" tabIndex={-1}>
        <h1 className={s.srOnly}>Phone details</h1>
        <Stage />

        <div>
          <Suspense fallback={<div className={s.tabs} style={{ height: 30 }} />}>
            <TabPanel phoneId={id} search={searchParams} />
          </Suspense>
        </div>
      </main>
    </>
  );
}

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
};

export default function PhonePage(props: Props) {
  return <Suspense fallback={<Loading />}><PhoneContent {...props} /></Suspense>;
}

async function StoredPhone({ phone, user, search, syncError }: {
  phone: Phone;
  user: { id: number; login: string; initials: string };
  search: Promise<{ tab?: string }>;
  syncError: string | null;
}) {
  const { tab: rawTab } = await search;
  const tab = (rawTab && tabSet.has(rawTab) ? rawTab : "log") as Tab;
  return <>
    <KeyboardTools phones={listPhones(user.id).map(item => ({ id: item.id, name: item.id }))} />
    <Topbar breadcrumb={["Phones", phone.id]}>
      <Pill kind={phoneCard(phone).state}>{phone.state}</Pill>
      <PhoneMutation id={phone.id} state={phone.keeping ? "keeping" : phone.state} />
      <Avatar initials={user.initials} login={user.login} />
    </Topbar>
    <main className={s.detail} id="main-content" tabIndex={-1}>
      <PhoneRefresh />
        <h1 className={s.srOnly}>Phone details</h1>
      <section className={`${s.stage} ${s.disconnected}`} aria-label="Phone screen">
        <div className={s.emptyPhone} aria-hidden />
        <h2>{phone.state === "stopped" ? "Resting, ready to resume" : "Waiting for the screen"}</h2>
        <p>{phone.state === "stopped" ? "Your codespace keeps the phone. Waking it resumes the same device." : "The live screen will appear when this phone connects."}</p>
        {phone.state_detail && <p role="status">{phone.state_detail}</p>}
        {syncError && <p role="status">{syncError}</p>}
      </section>
      <div>
        <Tabs active={tab} phoneId={phone.id} />
        <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === "danger" ? <DangerPanel phoneName={phone.id} /> :
          <LogFeed title={`${tab === "apps" ? "Installed apps" : tab === "backups" ? "Backups" : "Activity"} for ${phone.id}`} rows={tab === "log" ? phoneEvents(user.id, phone.id) : []} live={false} emptyMessage={tab === "apps" ? "No apps listed. Installed packages will appear when this phone connects." : tab === "backups" ? "No named backups yet. Backups are opt-in. Stopping still keeps the phone and its snapshot." : "No activity yet. Steps will appear when this phone connects."} />}
        </section>
        <div className={s.subgrid}>
          <Mini title="This phone" rows={[["Slot", phone.codespace_name], ["Machine", phone.machine], ["State", phone.state], ["Idle timeout", `Stops after ${idleLabel(phone.idle_timeout_min)} idle`]]} />
        </div>
        <p className={s.fineprint}>Idle timeout is set when the phone is created. <a href="https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces" target="_blank" rel="noreferrer">GitHub timeout settings</a></p>
      </div>
    </main>
  </>;
}
