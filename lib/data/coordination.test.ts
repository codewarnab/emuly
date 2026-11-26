import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, transaction } from "./async-database.ts";
import { migrateHosted } from "./hosted-migrations.ts";
import { withLease, CoordinationBusyError, independentWork, holdLease, leaseHeld } from "./coordination.ts";

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

test("lease completion rejects expired ownership even when work makes no transaction", async () => {
  const database = createClient({ url: "file::memory:" });
  try {
    await migrateHosted(database);
    await assert.rejects(withLease(database, "expired", async () => {
      await database.execute("UPDATE coordination_leases SET expires_at = 0 WHERE resource = 'expired'");
      return "stale result";
    }), CoordinationBusyError);
  } finally { database.close(); }
});

test("holdLease excludes a second owner until release or expiry", async () => {
  const database = createClient({ url: "file::memory:" });
  try {
    await migrateHosted(database);
    const first = await holdLease(database, "phone:p:busy");
    assert.ok(first);
    assert.equal(await holdLease(database, "phone:p:busy"), null);
    assert.equal(await leaseHeld(database, "phone:p:busy"), true);
    await first.release();
    assert.equal(await leaseHeld(database, "phone:p:busy"), false);
    const second = await holdLease(database, "phone:p:busy");
    assert.ok(second);
    await database.execute("UPDATE coordination_leases SET expires_at = 0 WHERE resource = 'phone:p:busy'");
    const third = await holdLease(database, "phone:p:busy");
    assert.ok(third, "an expired lease can be taken again");
    await second.release();
    assert.equal(await leaseHeld(database, "phone:p:busy"), true, "a stale owner cannot release the new owner's lease");
    await third.release();
  } finally { database.close(); }
});
