import { agentPhoneApi, phoneApi } from "../../../lib/api";

export async function GET(request: Request) {
  return agentPhoneApi().list(request);
}

export async function POST(request: Request) {
  return phoneApi().create(request);
}
