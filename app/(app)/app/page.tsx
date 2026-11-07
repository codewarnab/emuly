import Loading from "./loading";
import { Suspense } from "react";
import { requireUser } from "../../../lib/auth";
import { listPhones, phoneCard } from "../../../lib/phones";
import { EmptyState } from "../../../components/empty-state";
import s from "../../../components/console.module.css";
import { PhoneCard } from "../../../components/phone-card";
import { AddCard } from "../../../components/add-card";
import { QuotaStrip } from "../../../components/quota-strip";
import { Button } from "../../../components/button";
import { Topbar, Avatar } from "../../../components/topbar";

/** Board block 02 — dashboard: 2 phone cards max + add-card + quota strip. */
export default function DashboardPage() {
  return <Suspense fallback={<Loading />}><Dashboard /></Suspense>;
}

async function Dashboard() {
  const user = await requireUser();
  const phones = listPhones(user.id);
  // TODO(Phase 3): replace example quota numbers with explicitly labeled estimates.
  return (
    <>
      <Topbar
        nav={[
          { label: "Phones", on: true },
        ]}
      >
        <Avatar initials={user.initials} login={user.login} />
      </Topbar>
      <main className={s.pagewrap} id="main-content" tabIndex={-1}>
      <div className={s.pagehead}>
        <div>
          <h1>Your phones</h1>
          <p>
            Two max. Each one is a codespace in{" "}
            <span>
              {user.login}
            </span>
            &apos;s account.
          </p>
        </div>
        {phones.length > 0 && <div className={s.creationAction}>
          <Button disabled aria-describedby="creation-note">New phone</Button>
          <p className={s.availability} id="creation-note">Phone creation is coming soon.</p>
        </div>}
      </div>

      {phones.length === 0 ? (
        <EmptyState title="No phones yet"
          sub="Copy the setup prompt into your coding agent to get your first phone. It runs in your own GitHub Codespace." />
      ) : (
        <div className={s.grid}>
          {phones.map(phone => <PhoneCard key={phone.id} phone={phoneCard(phone)} on={phone.state === "running"} />)}
          {phones.length < 2 && <AddCard />}
        </div>
      )}

      <QuotaStrip />
    </main>
    </>
  );
}
