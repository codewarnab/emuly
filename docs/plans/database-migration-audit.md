# Hosted database migration audit

Audited 2026-11-08 against the current working tree for issue #3. Existing unrelated edits were preserved.

## Recommendation

Use remote Turso/libSQL as the first candidate. This preserves most SQLite SQL and avoids combining hosting changes with a full dialect rewrite. This is a recommendation, not a verified deployment choice. Prove transaction, binary-value, SQL-function, and latency compatibility before committing to it.

Postgres remains viable but requires substantially more SQL changes. Neither option preserves the synchronous application API.

## Confirmed scope

- `lib/data/database.ts` defines nine migration batches and 23 tables. It creates a local directory, opens `DatabaseSync`, enables WAL/foreign keys/busy timeout, and uses `PRAGMA user_version` for migrations.
- `lib/data/db.ts` caches the connection in `globalThis` and runs migrations on application access. A reusable remote client can still be cached; persistent state must live remotely.
- 18 production library files reference `DatabaseSync`. Direct SQL consumers also include OAuth callback, proxy, pages, layouts, actions, API authorization, phone services, and GitHub token handling. Scope extends well beyond `lib/data/`.
- Tables cover users, sessions, phones, events, backups, usage snapshots, runs, settings, notices, webhooks, delivery retries, creation recovery, keep operations, diagnostics, setup attempts, and poller backoff.

## Required changes

1. **Async calls throughout the consumer graph.** Replace synchronous `prepare().get/all/run()` calls with awaited remote operations. Update `readSession`, proxy, auth, settings, phone helpers, diagnostics, event emission, routes, pages, and actions. `EventEmitter` currently returns `void`; asynchronous writes must be awaited. Avoid one network round trip per existing statement where a batch or join can do the work.
2. **Explicit transaction clients.** `BEGIN IMMEDIATE` protects settings, mutation rate checks plus action reservations, creation confirmation, notices plus webhook fan-out, webhook test rate limits, and delivery result updates. Pass one transaction client through every nested helper. Using the root client inside those helpers would break atomicity. Keep external HTTP calls outside short transactions.
3. **Shared operation coordination.** `phone-mutations.ts` uses process-local busy/setup/boot sets. `poller.ts` and `webhook-outbox.ts` use local running flags. These do not coordinate separate instances. Add expiring database leases or conditional state transitions where duplicate execution matters. Preserve the outbox's existing conditional delivery claim. Treat delivery as at-least-once after crashes.
4. **Shared token refresh coordination.** `github-token.ts` uses a process-local promise map for rotated OAuth refresh tokens. Separate instances can refresh the same token concurrently. Add a per-user refresh lease with reread after acquiring it, conditional completion, and expiry recovery. Do not hold an interactive database transaction open during token exchange.
5. **Deployment migrations and data transfer.** Remove schema changes from request startup. Run versioned migrations once as a controlled deployment step. Back up SQLite consistently, pause writers for final export, preserve IDs and binary ciphertext, verify row counts and foreign keys, then switch configuration. Preserve the encryption key through the existing secret mechanism. Rollback after new writes requires reconciliation; switching back to an old snapshot would lose those writes.

## SQL compatibility checklist

| Dependency | Evidence | Turso/libSQL approach | Postgres approach |
|---|---|---|---|
| SQLite connection and schema PRAGMAs | `database.ts`, `diagnostic-reports.ts` | Replace connection setup and verify supported remote operations; separate schema tracking | Replace PRAGMAs, migration tracking, and database-size reporting |
| Implicit integer IDs | `database.ts` | Preserve IDs and verify generated IDs after import | Define identity columns and reset sequences after import |
| `?` parameters and SQLite result objects | Across consumers | Adapt result rows and affected-row counts | Rewrite placeholders and result handling |
| `BLOB`, numeric flags, ISO text dates | Schema, auth, settings | Verify binary round trips and integer decoding | Choose explicit bytea/boolean/date mapping; update callers consistently |
| `INSERT OR IGNORE` | `poller.ts`, `shared/hours.ts` | Compatibility probe | Use targeted `ON CONFLICT DO NOTHING` |
| Targetless upsert | `poller.ts` | Compatibility probe | Specify the `user_id` conflict target |
| `randomblob`, `hex`, `json_each` | `events.ts` | Probe exact fan-out statement | Rewrite UUID generation and JSON membership while preserving atomic fan-out |
| `strftime` | `webhook-outbox.ts` | Probe exact date comparison | Rewrite date arithmetic |
| Hidden `rowid` ordering and pruning | Diagnostics and webhooks | Preserve or replace with explicit stable ordering | Add explicit ordering keys; rewrite bounded deletes |

## Implementation sequence

1. Build a small remote-client compatibility probe against a disposable database. Check rollback, dependent reads/writes, atomic fan-out, affected-row counts, binary values, foreign keys, generated IDs, and the SQL above. Measure representative authenticated read and transaction latency.
2. Introduce a small asynchronous database interface with an explicit transaction callback. Convert dependency chains in bounded groups: auth/settings, diagnostics/read models, events/webhooks, then phone mutations/poller. Keep local and hosted modes clearly configured during migration.
3. Add shared leases for token refresh, phone operations, and overlapping scheduled work. Verify concurrent callers from independent clients, not just one process.
4. Rehearse export/import and validation against a disposable destination. Verify session hashes, encrypted values, event ordering, recovery records, and next generated IDs without displaying secrets.
5. Cut over persistent storage. Handle Cron, stream routing, and APK storage as subsequent issue #3 work. Database completion alone does not make Vercel deployment ready.

## Verification and limits

This was static inspection only. No application code, tests, installers, database connections, credentials, or production data were executed or accessed. No hosted service was provisioned. Existing tests use local SQLite and will need migration-specific integration coverage; they cannot prove hosted behavior. Use an isolated disposable environment for that work under AGENTS.md.

Primary references checked: https://github.com/tursodatabase/libsql-client-ts and https://tursodatabase.github.io/libsql-client-ts/interfaces/Client.html document asynchronous remote operations and transactions. https://www.postgresql.org/docs/15/transaction-iso.html explains why default Postgres transaction isolation alone does not replace SQLite writer serialization.
