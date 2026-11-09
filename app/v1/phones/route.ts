import { agentPhoneApi, phoneApi } from "../../../lib/api";

export async function GET() {
  return agentPhoneApi().list();
}

export async function POST(request: Request) {
  return phoneApi().create(request);
}
