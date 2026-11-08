import { Suspense } from "react";
import { requireUser } from "../../../../lib/auth/auth";
import { asyncDb } from "../../../../lib/data/async-db";
import { chosenPlan } from "../../../../lib/data/settings";
import { savePlan } from "../../../actions/settings";
import { Topbar, Avatar } from "@/components/shell/topbar";
import { ConsoleLoading } from "@/components/ui/console-loading";
import s from "../../../../components/console.module.css";

const PLANS = [
  { id: "free", name: "GitHub Free", hours: 30, core: 120 },
  { id: "pro", name: "GitHub Pro", hours: 45, core: 180 },
] as const;

export default function WelcomePage() {
  return <Suspense fallback={<ConsoleLoading />}><Welcome /></Suspense>;
}

async function Welcome() {
  const user = await requireUser();
  const current = await chosenPlan(asyncDb(), user.id);
  return <>
    <Topbar nav={[{ label: "Phones" }, { label: "Settings" }]}>
      <Avatar initials={user.initials} login={user.login} />
    </Topbar>
    <main className={`${s.pagewrap} ${s.welcome}`} id="main-content" tabIndex={-1}>
      <h1>Which GitHub plan do you have?</h1>
      <p className={s.welcomeLede}>Your plan sets your free phone hours each month.</p>
      <form action={savePlan} className={s.planGrid}>
        {PLANS.map(plan => <button key={plan.id} name="plan" value={plan.id} type="submit"
          className={`${s.planCard} ${current === plan.id ? s.planCurrent : ""}`}>
          <span className={s.planName}>{plan.name}{current === plan.id && <small>Current</small>}</span>
          <span className={s.planHours}>{plan.hours}<small> h / month</small></span>
          <span className={s.planNote}>on a 4-core phone · {plan.core} core-hours</span>
        </button>)}
      </form>
      <p className={s.welcomeHint}>
        Not sure? <a href="https://github.com/settings/billing" target="_blank" rel="noreferrer">See your plan on GitHub</a>.
      </p>
    </main>
  </>;
}
