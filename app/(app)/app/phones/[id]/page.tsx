import { asyncDb } from "../../../../../lib/data/async-db";
import Link from "next/link";
import { shortMessage } from "../../../../../lib/shared/short-message";
import { phoneName } from "../../../../../lib/shared/phone-name";
import { PHONE_TABS } from "../../../../../lib/shared/keyboard";
import { idleLabel } from "../../../../../lib/shared/idle";
import { machineRows } from "../../../../../lib/shared/machine-specs";
import { phoneStatus } from "../../../../../lib/phone/phone-status";
import Loading from "./loading";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireUser } from "../../../../../lib/auth/auth";
import { findPhone, listPhones, phoneEvents, type Phone } from "../../../../../lib/phone/phones";
import { KeyboardTools } from "@/components/shell/keyboard-tools";
import { syncPhoneState } from "../../../../../lib/phone/phone-control";
import type { SyncError } from "../../../../../lib/shared/sync-error";
import { SyncNotice } from "@/components/shell/sync-notice";
import { PhoneMutation, PhoneRefresh, RetryBoot } from "@/components/phone/phone-mutations";
import { PhoneScreen, AndroidElapsed } from "@/components/phone/phone-screen";
import s from "../../../../../components/console.module.css";
import { Topbar, Avatar } from "@/components/shell/topbar";
import { Stage } from "@/components/phone/stage";
import { Tabs, type Tab } from "@/components/ui/tabs";
import { LogFeed } from "@/components/ui/log-feed";
import { Mini, UrlRow } from "@/components/ui/mini";
import { DangerPanel } from "@/components/phone/danger-panel";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { mockLog, mockDetail, mockPhones } from "@/lib/shared/fixtures";
import { streamQuality } from "../../../../../lib/shared/display-settings";
import { PhoneApps } from "@/components/phone/phone-apps";

// A Stop server action may call the runner three times, up to 80 s each.
export const maxDuration = 300;

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

      <section role="tabpanel" className={s.tabPanel} id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
      {tab === "log" && (
        <>
          <LogFeed title={`Activity for ${phoneName(mockLog.phone)}`} rows={mockLog.rows} />
          <UrlRow url={mockDetail.streamUrl} />
          <div className={s.subgrid}>
            <Mini title="This phone" rows={mockDetail.thisPhone} />
          </div>
        </>
      )}

      {tab === "apps" && (
        <LogFeed title={`Installed apps for ${phone.name}`} rows={[]} live={false} emptyMessage="No apps yet." />
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
  let phone = (await findPhone(user.id, id));
  const mock = process.env.EMULY_MOCK === "1" && id === "phone-7f2a";
  if (!phone && !mock) notFound();
  if (!mock && phone) {
    const syncError = await syncPhoneState(user.id);
    phone = (await findPhone(user.id, id));
    if (!phone) notFound();
    return <StoredPhone phone={phone} user={user} search={searchParams} syncError={syncError} />;
  }

  return (
    <>
      <KeyboardTools phones={(await listPhones(user.id)).map(item => ({ id: item.id, name: item.name,
        ...(item.id === mockDetail.phone ? { stream: mockDetail.streamUrl, adb: mockDetail.thisPhone.find(([key]) => key === "adb")?.[1] } : {}),
      }))} />
      <Topbar breadcrumb={["Phones", phoneName(mockDetail.phone)]}>
        <Pill kind={mockDetail.state}>
          running <span className={s.upTxt}>for {mockDetail.upFor}</span>
        </Pill>
        <Button variant="ghost" tiny disabled aria-describedby="phone-control-note">
          Stop
        </Button>
        <span id="phone-control-note" className={s.srOnly}>Phone controls are not connected yet.</span>
        <Avatar initials={user.initials} login={user.login} avatarUrl={user.avatarUrl} />
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
  user: { id: number; login: string; initials: string; avatarUrl: string | null };
  search: Promise<{ tab?: string }>;
  syncError: SyncError | null;
}) {
  const { tab: rawTab } = await search;
  const tab = (rawTab && tabSet.has(rawTab) ? rawTab : "log") as Tab;
  const screenReady = !phone.keeping && phone.state === "running" && phone.android_state === "ready";
  const status = phoneStatus(phone);
  const events = await phoneEvents(user.id, phone.id);
  const androidBooting = phone.state === "running" && phone.android_state === "booting";
  const inProgress = Boolean(phone.keeping) || ["pending", "booting", "stopping"].includes(phone.state);
  // The newest event marks when the current step began.
  const stepStarted = androidBooting ? phone.android_started_at : events[0]?.at ?? null;
  return <>
    <KeyboardTools phones={(await listPhones(user.id)).map(item => ({ id: item.id, name: item.name }))} />
    <Topbar breadcrumb={["Phones", phone.name]}>
      <Avatar initials={user.initials} login={user.login} avatarUrl={user.avatarUrl} />
    </Topbar>
    <main className={`${s.detail} ${screenReady ? s.detailLive : ""}`} id="main-content" tabIndex={-1}>
      {(!syncError || syncError.kind === "other") && <PhoneRefresh />}
        <h1 className={s.srOnly}>Phone details</h1>
      <section className={`${s.stage} ${s.disconnected} ${screenReady ? s.liveStage : ""}`} aria-label="Phone screen">
        {screenReady &&
          <PhoneScreen key={phone.id} id={phone.id} resting={false} live quality={await streamQuality(asyncDb(), user.id)} />}
        {phone.state !== "running" && phone.state !== "stopped" && <div className={s.emptyPhone} aria-hidden />}
        {!screenReady && <h2>{status.title}</h2>}
        {(androidBooting || inProgress) && <AndroidElapsed key={stepStarted ?? "none"} started={stepStarted} />}
        {phone.state === "running" && phone.android_state === "failed" && <><p>{phone.android_error}</p><RetryBoot id={phone.id} /></>}
        {(phone.state !== "running" || Boolean(phone.keeping)) && <>
        <p>{phone.state === "error" ? shortMessage(status.description) : status.description}</p>
        </>}
        {syncError && <SyncNotice error={syncError} />}
        {/* The one action that fits the state, next to the state it fixes. */}
        <div className={screenReady ? s.liveStageFooter : undefined}>
        {screenReady && <Pill kind={status.kind}>{status.label}</Pill>}
        {phone.codespace_name.startsWith("pending:")
          ? phone.state === "error" && <Link className={`${s.btn} ${s.btnTiny} ${s.btnGhost}`} href={`/app/phones/${encodeURIComponent(phone.id)}?tab=danger`}>Delete this phone</Link>
          : <PhoneMutation id={phone.id} state={phone.keeping ? "keeping" : phone.state} />}
        </div>
      </section>
      <div>
        <Tabs active={tab} phoneId={phone.id} />
        <section role="tabpanel" className={s.tabPanel} id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === "danger" ? <DangerPanel phoneName={phone.id} /> : tab === "apps" ? <PhoneApps key={phone.id} id={phone.id} ready={screenReady} /> :
          <LogFeed rows={tab === "log" ? events : []} live={false}
            running={tab === "log" ? `Current status: ${status.title}` : undefined} emptyMessage="No activity yet." />}
        </section>
        <div className={s.subgrid}>
          <Mini title="Host codespace" rows={[...machineRows(phone.machine, phone.cores), ["Idle stop", idleLabel(phone.idle_timeout_min)]]} />
        </div>
        <p className={s.fineprint}><a href="https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces" target="_blank" rel="noreferrer">GitHub timeout settings</a></p>
      </div>
    </main>
  </>;
}
