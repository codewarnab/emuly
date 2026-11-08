import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, transaction } from "./async-database.ts";
import { migrateHosted } from "./hosted-migrations.ts";
import { withLease, CoordinationBusyError, independentWork } from "./coordination.ts";

test("database leases exclude competing work and fence a worker after lease takeover", async () => {
  const database = createClient({ url: "file::memory:" });
  try {
    await migrateHosted(database);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withLease(database, "fixture", async () => {
      entered();
      await gate;
      return transaction(database, queries => queries.execute("DELETE FROM users"));
    });
    const rejected = assert.rejects(first, CoordinationBusyError);
    await ready;
    await assert.rejects(withLease(database, "fixture", async () => {}), CoordinationBusyError);
    await withLease(database, "unrelated", async () => {});
    await database.execute("UPDATE coordination_leases SET expires_at = 0 WHERE resource = 'fixture'");
    await independentWork(() => withLease(database, "fixture", async () => { release(); await rejected; }));
    assert.equal((await database.execute("SELECT * FROM coordination_leases")).rows.length, 0);
  } finally { database.close(); }
});
