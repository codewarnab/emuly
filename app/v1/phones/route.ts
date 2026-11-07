import { phoneApi } from "../../../lib/api";

export async function POST(request: Request) {
  return phoneApi().create(request);
}
