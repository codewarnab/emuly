import { webhookApi } from "../../../lib/api";

export const GET = (request: Request) => webhookApi()(request);
export const POST = (request: Request) => webhookApi()(request);
