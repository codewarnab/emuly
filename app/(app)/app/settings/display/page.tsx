import { requireUser } from "../../../../../lib/auth/auth";
import { db } from "../../../../../lib/data/db";
import { streamQuality } from "../../../../../lib/shared/display-settings";
import { DisplaySettings } from "@/components/settings/display-settings";

export default async function DisplayPage() {
  const user = await requireUser();
  return <DisplaySettings initial={streamQuality(db(), user.id)} />;
}
