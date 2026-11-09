import { Suspense } from "react";
import { asyncDb } from "../../../../../lib/data/async-db";
import { requireUser } from "../../../../../lib/auth/auth";
import { streamQuality } from "../../../../../lib/shared/display-settings";
import { DisplaySettings } from "@/components/settings/display-settings";
import s from "../../../../../components/console.module.css";

export default function DisplayPage() {
  return <Suspense fallback={<div role="status" aria-label="Loading display settings" className={s.skeletonLine} />}>
    <DisplayContent />
  </Suspense>;
}

async function DisplayContent() {
  const user = await requireUser();
  return <DisplaySettings initial={await streamQuality(asyncDb(), user.id)} />;
}
