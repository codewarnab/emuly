import { Suspense } from "react";
import { requireUser } from "../../../../../lib/auth/auth";
import { asyncDb } from "../../../../../lib/data/async-db";
import { listAgentKeys } from "../../../../../lib/data/agents";
import { listAgentPhoneDeletions } from "../../../../../lib/data/phone-deletions";
import { userSettings } from "../../../../../lib/data/settings";
import { ConnectedAgents } from "@/components/settings/connected-agents";
import s from "../../../../../components/console.module.css";

export default function AgentsPage() {
  return <>
    <p className={s.settingHint}>Agents connect with a key from a copied prompt. The key can use phones, but cannot change settings or delete a phone unless you allow it below.</p>
    <Suspense fallback={<div role="status" aria-label="Loading connected agents" className={s.skeletonLine} />}>
      <AgentsContent />
    </Suspense>
  </>;
}

async function AgentsContent() {
  const user = await requireUser();
  const database = asyncDb();
  const [keys, settings, deletions] = await Promise.all([
    listAgentKeys(database, user.id),
    userSettings(database, user.id),
    listAgentPhoneDeletions(database, user.id),
  ]);
  return <ConnectedAgents initial={keys} deleteWithoutAsking={settings.agent_delete_phones} deletions={deletions} />;
}
