import "server-only";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "./async-database.ts";
import type { Client } from "@libsql/client";
import { env } from "../env.ts";

const globalDb = globalThis as unknown as { __phonelinkAsyncDb?: Client };

/** No schema writes during requests. Run db:migrate before starting the app. */
export function asyncDb(): Client {
  if (!globalDb.__phonelinkAsyncDb) {
    const remoteUrl = process.env.PHONELINK_DATABASE_URL;
    const authToken = process.env.PHONELINK_DATABASE_AUTH_TOKEN;
    if (remoteUrl && (!/^(libsql|https):\/\//.test(remoteUrl) || !authToken)) {
      throw new Error("Hosted database requires a remote URL and database auth token.");
    }
    globalDb.__phonelinkAsyncDb = createClient({
      url: remoteUrl || pathToFileURL(resolve(env.dbPath)).href,
      authToken: remoteUrl ? authToken : undefined,
    });
  }
  return globalDb.__phonelinkAsyncDb;
}
