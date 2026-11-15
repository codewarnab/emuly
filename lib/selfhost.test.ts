import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { createClient } from "./data/async-database.ts";
import { openDatabase } from "./data/database.ts";
import { createGhTokenSource, selfHostTokenKey, selfHostUser } from "./selfhost.ts";

const identity = { login: "octocat", id: 583231, name: "The Octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231" };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "emuly-selfhost-"));
  const database = openDatabase(join(directory, "test.db"));
  const client = createClient({ url: pathToFileURL(join(directory, "test.db")).href });
  return {
    directory, database, client,
    async close() {
      client.close();
      database.close();
      globalThis.gc?.();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test("selfHostUser inserts on first call and updates the same row on the next", async () => {
  const f = fixture();
  try {
    const first = await selfHostUser(f.client, { identity });
    assert.equal(first.login, "octocat");
    assert.equal(first.name, "The Octocat");
    assert.equal(first.initials, "TO");
    assert.equal(first.authKind, "session");
    const row = f.database.prepare("SELECT github_id, token_cipher, token_scopes FROM users").get() as
      { github_id: number; token_cipher: Uint8Array; token_scopes: string };
    assert.equal(row.github_id, 583231);
    assert.equal(row.token_cipher.length, 0);
    assert.equal(row.token_scopes, "");
    // A renamed account updates the row instead of inserting a second one.
    const second = await selfHostUser(f.client, { identity: { ...identity, login: "new-name" } });
    assert.equal(second.id, first.id);
    assert.equal(second.login, "new-name");
    assert.equal((f.database.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n, 1);
  } finally { await f.close(); }
});

test("selfHostUser shares concurrent initialization and performs no repeated writes", async () => {
  const f = fixture();
  try {
    f.database.exec(`CREATE TABLE writes (n INTEGER); INSERT INTO writes VALUES (0);
      CREATE TRIGGER user_writes AFTER UPDATE ON users BEGIN UPDATE writes SET n = n + 1; END;
      CREATE TRIGGER session_writes AFTER UPDATE ON sessions BEGIN UPDATE writes SET n = n + 1; END;`);
    const users = await Promise.all(Array.from({ length: 8 }, () => selfHostUser(f.client, { identity })));
    await selfHostUser(f.client, { identity });
    assert.ok(users.every(user => user.id === users[0].id));
    assert.equal((f.database.prepare("SELECT n FROM writes").get() as { n: number }).n, 0);
    await selfHostUser(f.client, { identity: { ...identity, login: "renamed" } });
    assert.equal((f.database.prepare("SELECT n FROM writes").get() as { n: number }).n, 2);
  } finally { await f.close(); }
});

test("selfHostUser derives initials from the name, or from the login when there is no name", async () => {
  const f = fixture();
  try {
    assert.equal((await selfHostUser(f.client, { identity: { ...identity, name: "ada" } })).initials, "A");
    assert.equal((await selfHostUser(f.client, { identity: { ...identity, name: "Grace Brewster Hopper" } })).initials, "GB");
    assert.equal((await selfHostUser(f.client, { identity: { ...identity, name: null } })).initials, "OC");
    assert.equal((await selfHostUser(f.client, { identity: { ...identity, login: "li", name: "  " } })).initials, "LI");
  } finally { await f.close(); }
});

test("selfHostUser upserts the constant 'self-host' session row the stream validators check", async () => {
  const f = fixture();
  try {
    const first = await selfHostUser(f.client, { identity });
    const row = f.database.prepare("SELECT id, user_id, expires_at FROM sessions").get() as
      { id: string; user_id: number; expires_at: string };
    assert.equal(row.id, "self-host");
    assert.equal(row.user_id, first.id);
    assert.equal(Date.parse(row.expires_at) > Date.now(), true);
    // The events/actions streams validate exactly this shape: session id, blocked user,
    // unexpired session, matching user id.
    const valid = (await f.client.execute({ sql: `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND u.blocked = 0 AND s.expires_at > ? AND s.user_id = ?`,
      args: [row.id, new Date().toISOString(), row.user_id] })).rows.length;
    assert.equal(valid, 1);
    // A re-upsert updates the row in place instead of duplicating or orphaning it.
    const second = await selfHostUser(f.client, { identity: { ...identity, login: "new-name" } });
    assert.equal((f.database.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n, 1);
    assert.equal(row.user_id, second.id);
  } finally { await f.close(); }
});

test("selfHostUser rejects a user blocked in the local database", async () => {
  const f = fixture();
  try {
    await selfHostUser(f.client, { identity });
    f.database.exec("UPDATE users SET blocked = 1");
    await assert.rejects(selfHostUser(f.client, { identity }),
      /blocked in the local Emuly database/);
  } finally { await f.close(); }
});

test("selfHostTokenKey validates and memoizes the key, and repairs a bad file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "emuly-selfhost-key-"));
  process.env.EMULY_DB = join(directory, "test.db");
  try {
    const first = selfHostTokenKey();
    const file = join(directory, "token.key");
    assert.equal(Buffer.from(first, "base64").length, 32);
    // 0600: the key seals GitHub tokens at rest in the same directory.
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // Memoized per process: a changed file on disk must not re-key the running app.
    writeFileSync(file, "not-a-key");
    assert.equal(selfHostTokenKey(), first);
    // A fresh process treats an empty or malformed file as missing and regenerates it.
    writeFileSync(file, "");
    // The query string dodges the module cache: a second import acts like a new process.
    const specifier = `./selfhost.ts?fresh-instance-${randomBytes(4).toString("hex")}`;
    const fresh = (await import(specifier)) as typeof import("./selfhost.ts");
    const second = fresh.selfHostTokenKey();
    assert.notEqual(second, first);
    assert.equal(Buffer.from(second, "base64").length, 32);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // Regenerating into a wider-mode empty file must tighten the mode too: writeFileSync
    // keeps an existing file's mode, so only the explicit chmod covers this case.
    rmSync(file);
    writeFileSync(file, "", { mode: 0o644 });
    assert.equal(statSync(file).mode & 0o777, 0o644);
    const emptySpecifier = `./selfhost.ts?empty-instance-${randomBytes(4).toString("hex")}`;
    const empty = (await import(emptySpecifier)) as typeof import("./selfhost.ts");
    empty.selfHostTokenKey();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // A pre-existing valid file is kept, and its mode is tightened to 0600. Recreate
    // the file so the 0644 mode actually applies (writeFileSync keeps an existing mode).
    const manualKey = randomBytes(32).toString("base64");
    rmSync(file);
    writeFileSync(file, `${manualKey}\n`, { mode: 0o644 });
    const keptSpecifier = `./selfhost.ts?kept-instance-${randomBytes(4).toString("hex")}`;
    const kept = (await import(keptSpecifier)) as typeof import("./selfhost.ts");
    assert.equal(kept.selfHostTokenKey(), manualKey);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // A stale lock from a crashed process is stolen instead of blocking forever.
    const lock = `${file}.lock`;
    writeFileSync(lock, "", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const staleSpecifier = `./selfhost.ts?stale-instance-${randomBytes(4).toString("hex")}`;
    const stale = (await import(staleSpecifier)) as typeof import("./selfhost.ts");
    assert.equal(Buffer.from(stale.selfHostTokenKey(), "base64").length, 32);
    assert.equal(existsSync(lock), false, "the lock is released after initialization");
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("createGhTokenSource shares one in-flight read between concurrent callers", async () => {
  let time = 1_000;
  const clock = () => time;
  let calls = 0;
  const run = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return `token-${calls}`;
  };
  const source = createGhTokenSource(run, { ttlMs: 60_000, clock });
  const results = await Promise.all([source(), source(), source()]);
  assert.equal(calls, 1, "concurrent callers coalesce into a single gh run");
  assert.deepEqual(results, ["token-1", "token-1", "token-1"]);
  time += 60_001;
  await source();
  assert.equal(calls, 2);
});

test("createGhTokenSource caches hits and rejections within the TTL and refetches after it", async () => {
  let time = 1_000;
  const clock = () => time;
  const calls: string[] = [];
  let fail = false;
  const run = async (_file: string, args: string[]) => {
    calls.push(args.join(" "));
    if (fail) throw new Error("gh auth token failed: not logged in");
    return "synthetic-token";
  };
  const token = createGhTokenSource(run, { ttlMs: 60_000, clock });
  await assert.equal(await token(), "synthetic-token");
  await assert.equal(await token(), "synthetic-token");
  assert.deepEqual(calls, ["auth token"], "a second call inside the TTL does not run gh again");
  fail = true;
  time += 60_001;
  await assert.rejects(token(), /^Error: gh auth token failed: not logged in$/);
  await assert.rejects(token(), /^Error: gh auth token failed: not logged in$/);
  assert.deepEqual(calls, ["auth token", "auth token"], "one run per TTL window, including a failure");
  fail = false;
  time += 60_001;
  await assert.equal(await token(), "synthetic-token");
  assert.equal(calls.length, 3);
});
