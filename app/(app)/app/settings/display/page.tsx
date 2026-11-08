import { asyncDb } from "../../../../../lib/data/async-db";
import { requireUser } from "../../../../../lib/auth/auth";
import { streamQuality } from "../../../../../lib/shared/display-settings";
import { DisplaySettings } from "@/components/settings/display-settings";

export default async function DisplayPage() {
  const user = await requireUser();
  return <DisplaySettings initial={await streamQuality(asyncDb(), user.id)} />;
}
