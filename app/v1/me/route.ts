import { phoneApi } from "../../../lib/api";

/** The GitHub account behind this key or session. */
export async function GET() {
  return phoneApi().me();
}
