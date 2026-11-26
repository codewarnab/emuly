import { GITHUB_PLAN_URL, PLANS as GITHUB_PLANS, phoneHours } from "@/lib/shared/plans";
import { Suspense } from "react";
import { requireUser } from "../../../../lib/auth/auth";
import { asyncDb } from "../../../../lib/data/async-db";
import { chosenPlan } from "../../../../lib/data/settings";
import { savePlan } from "../../../actions/settings";
import { safeNext } from "../../../../lib/auth/next-path";
import { Topbar, Avatar } from "@/components/shell/topbar";
import { ConsoleLoading } from "@/components/ui/console-loading";
import s from "../../../../components/console.module.css";

const PLANS = [
  { id: "free", name: GITHUB_PLANS.free.name, hours: phoneHours("free"), core: GITHUB_PLANS.free.coreHours },
  { id: "pro", name: GITHUB_PLANS.pro.name, hours: phoneHours("pro"), core: GITHUB_PLANS.pro.coreHours },
] as const;

type Props = { searchParams: Promise<{ next?: string | string[] }> };

export default function WelcomePage(props: Props) {
  return <Suspense fallback={<ConsoleLoading />}><Welcome {...props} /></Suspense>;
}

/** `next` returns the user to the agent sign-in page after the plan choice. */
async function Welcome({ searchParams }: Props) {
  const raw = (await searchParams).next;
  const next = safeNext(Array.isArray(raw) ? raw[0] : raw);
  const user = await requireUser();
  const current = await chosenPlan(asyncDb(), user.id);
  return <>
    <Topbar nav={[{ label: "Phones" }, { label: "Settings" }]}>
      <Avatar initials={user.initials} login={user.login} avatarUrl={user.avatarUrl} />
    </Topbar>
    <main className={`${s.pagewrap} ${s.welcome}`} id="main-content" tabIndex={-1}>
      <h1>Which GitHub plan do you have?</h1>
      <p className={s.welcomeLede}>Your plan sets your free phone hours each month.</p>
      <form action={savePlan} className={s.planGrid}>
        {next && <input type="hidden" name="next" value={next} />}
        {PLANS.map(plan => <button key={plan.id} name="plan" value={plan.id} type="submit"
          className={`${s.planCard} ${current === plan.id ? s.planCurrent : ""}`}>
          <span className={s.planName}>{plan.name}{current === plan.id && <small>Current</small>}</span>
          <span className={s.planHours}>{plan.hours}<small> h / month</small></span>
          <span className={s.planNote}>on a 4-core phone · {plan.core} core-hours</span>
        </button>)}
      </form>
      <p className={s.welcomeHint}>
        Not sure? <a href={GITHUB_PLAN_URL} target="_blank" rel="noreferrer">See your plan on GitHub</a>.
      </p>
    </main>
  </>;
}
