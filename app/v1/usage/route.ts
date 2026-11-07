import { phoneApi } from "../../../lib/api";

export async function GET() {
  return phoneApi().usage();
}
