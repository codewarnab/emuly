import { requireUser } from "../../../../../lib/auth";
import { db } from "../../../../../lib/db";
import { streamQuality } from "../../../../../lib/display-settings";
import { DisplaySettings } from "@/components/settings/display-settings";

export default async function DisplayPage() {
  const user = await requireUser();
  return <DisplaySettings initial={streamQuality(db(), user.id)} />;
}
