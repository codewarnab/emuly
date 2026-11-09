import { Suspense } from "react";
import { requireUser } from "../../../../../lib/auth/auth";
import { asyncDb } from "../../../../../lib/data/async-db";
import { listAgentKeys } from "../../../../../lib/data/agents";
import { ConnectedAgents } from "@/components/settings/connected-agents";
import s from "../../../../../components/console.module.css";

export default function AgentsPage() {
  return <>
    <p className={s.settingHint}>Agents connect with a key from a copied prompt. The key can use phones but cannot change settings or delete a phone.</p>
    <Suspense fallback={<div role="status" aria-label="Loading connected agents" className={s.skeletonLine} />}>
      <AgentsContent />
    </Suspense>
  </>;
}

async function AgentsContent() {
  const user = await requireUser();
  return <ConnectedAgents initial={await listAgentKeys(asyncDb(), user.id)} />;
}
