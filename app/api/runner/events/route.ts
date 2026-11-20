import { asyncDb } from "../../../../lib/data/async-db";
import { env } from "../../../../lib/env";
import { handleRunnerEvent } from "../../../../lib/phone/runner-events";
import { runnerRequest } from "../../../../lib/phone/phone-runner";
import { redact } from "../../../../lib/phone/phone-mutations";

/** Push events from phone runners (phone/runner/events.mjs). The handler checks the phone signature. */
export async function POST(request: Request) {
  return handleRunnerEvent(request, {
    database: asyncDb(), secrets: env.tokenKeys, baseUrl: process.env.EMULY_BASE_URL, redact,
    confirmBooted: async (userId, id) => (await (await runnerRequest(userId, id, "/health")).json()).booted === true,
  });
}
