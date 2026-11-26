import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@libsql/client";
import { transaction } from "./async-database.ts";

function fakeClient(protocol: string) {
  const log: string[] = [];
  const client = {
    protocol,
    async transaction() {
      return {
        async execute() { return { rows: [], rowsAffected: 0 }; },
        async commit() { log.push("commit"); },
        async rollback() { log.push("rollback"); },
        close() { log.push("close"); },
      };
    },
  };
  return { client: client as unknown as Client, log };
}

test("a slow Turso transaction does not make another user's transaction wait", async () => {
  const { client } = fakeClient("libsql");
  let release!: () => void;
  const slow = transaction(client, () => new Promise<void>(resolve => { release = resolve; }));
  let fastDone = false;
  const fast = transaction(client, async () => { fastDone = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fastDone, "the second transaction ran while the first one was still open");
  release();
  await Promise.all([slow, fast]);
});

test("a transaction that runs past the timeout is rolled back and fails", async () => {
  const { client, log } = fakeClient("libsql");
  await assert.rejects(transaction(client, () => new Promise(() => {}), 30), /longer than 30 ms/);
  assert.deepEqual(log, ["rollback", "close"]);
});

test("local file: SQLite still runs one transaction at a time", async () => {
  const { client } = fakeClient("file");
  let release!: () => void;
  const slow = transaction(client, () => new Promise<void>(resolve => { release = resolve; }));
  let fastDone = false;
  const fast = transaction(client, async () => { fastDone = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fastDone, false, "file: keeps the queue");
  release();
  await Promise.all([slow, fast]);
  assert.ok(fastDone);
});
