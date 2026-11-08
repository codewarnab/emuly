# Database foundation and authentication batch

Implemented 2026-11-08. This is the first implementation batch for issue #3, not a hosted-app cutover.

## Changes

- Shared migration SQL now lives in `lib/data/migrations.ts`. Existing SQLite migrations retain their order and SQL.
- `pnpm db:migrate` applies local migrations explicitly. Request connections no longer apply migrations and refuse an outdated local schema.
- `migrateHosted` applies the same SQL with `schema_migrations` tracking. Each migration and its history record commit together. A write transaction rechecks history to serialize competing deployers.
- `asyncDb` uses the existing SQLite file by default, or a configured Turso URL and token. `transaction` supplies an explicit query handle and rolls back on failure.
- OAuth user reads/upserts, session creation/read/deletion, `getUser`, and proxy authentication now await database operations. Session rotation deletes the old session and inserts its replacement in one transaction.

## Configuration and limits

For local development, leave `PHONELINK_DATABASE_URL` unset and run `pnpm db:migrate` before starting the application. Existing SQLite records are retained. Restart the server after changing database configuration.

Hosted connection settings are `PHONELINK_DATABASE_URL` and `PHONELINK_DATABASE_AUTH_TOKEN`. Supply credentials through the existing secret mechanism. The migration command also accepts URL-file and token-file paths as its two positional arguments. Neither command arguments nor logs contain credential values.

Do not enable hosted mode for the full application yet. Phone operations, activity events, display preferences, auto-stop acknowledgements, most poller writes, and GitHub token refresh still use synchronous SQLite. Their `db()` entry point rejects hosted mode rather than silently using a different local database. Shared OAuth refresh coordination remains part of the later migration work.

No existing SQLite data has been imported to Turso. No active deployment configuration has changed. The test database is left empty after hosted integration checks.

## Validation

- Typecheck passed.
- Production build passed, with two tracing warnings from `lib/phone/phone-setup.ts`, outside this batch.
- Full suite passed before the final schema-gate test was added: 134 passed, one opt-in hosted test skipped. The hosted test was also run explicitly and passed.
- Hosted integration exercised the actual migration runner twice and actual session helpers: persisted session hashes, rotation rollback, successful rotation, logout, expiry, and blocked users. These are database-level auth checks; interactive GitHub OAuth/browser login was not exercised.
- Local migration command succeeded twice against a fresh temporary database.

Windows retains file handles when native SQLite and the libSQL client share some test files in one process. Auth session behavior is covered using an in-memory client, while existing SQLite migration/reopen tests remain separate. Earlier failed probe processes left temporary files pending cleanup; they contain synthetic fixtures only.

## Settings and usage batch (2026-11-08)

PR #14 stays open until the remaining issue #3 work is complete. This batch adds:

- Async Hours settings, onboarding plans, allowance overrides, usage reads, and database access in billing aggregation.
- Awaited reads/writes in pages, layouts, Server Actions, settings API, phone API, and poller budget/retention checks.
- Atomic settings updates through the supplied transaction handle. Reading the old settings and updating both settings tables share one write transaction.
- A temporary explicit `settingsDatabase` connection for the still-synchronous poller. Both clients use the same local SQLite file. Hosted mode remains blocked by the legacy consumers.
- Existing settings, phone, retention, and poller tests now exercise real libSQL connections. The test command exposes garbage collection so cleanup can release native SQLite statements before deleting files on Windows.

Validation: full suite passed (135 passed, one hosted test skipped); the hosted integration passed separately. Hosted checks now verify partial settings updates, rollback when the second settings write fails, account isolation, and usage totals. Typecheck and production build passed. Existing phone setup tracing warnings remain. Interactive browser login and settings UI were not exercised. Tests/build include unrelated working-tree phone/UI edits, which remain excluded from this PR.

## Diagnostics, events and webhooks batch (2026-11-08)

- Diagnostics storage, collection, reports, browser ingestion, and callers now await libSQL queries. Records, aggregates, and collector cursors commit together. Storage failures remain isolated from measured work. Diagnostics stay private and disabled by default.
- Webhook CRUD, event fan-out, tests, retries, claims, automatic disablement, API handlers, and settings pages use async queries. Rate checks and test enqueue share a write transaction. Claims commit before DNS or HTTP requests.
- Local libSQL operations queue while an interactive transaction holds its connection. Separate transaction handles prevent unrelated writes from entering a rollback. Remote transactions retain database locking across processes.
- Phone lifecycle and poller transactions still use an explicit `legacy-events.ts` bridge. It shares the sanitized fan-out statement and keeps fan-out atomic with native lifecycle writes. Activity log writes remain with that later batch. Remove this bridge when those transactions migrate.
- Native phone code temporarily receives the async diagnostics client against the same local file. Diagnostic lookup waits recheck phone state before starting setup or boot. Concurrent browser requests share one viewing window.

Validation: typecheck, production build, and full suite passed (135 passed, one hosted check skipped). Explicit Turso checks passed separately, including encrypted webhook delivery, sanitized payloads, test rate limits, ownership checks, and rollback of diagnostic records and aggregates when cursor writes fail. Duplicate collector batches aggregate once. The test database was cleared afterward. Existing phone setup tracing warnings remain. Tests/build include unrelated working-tree edits, excluded from this PR. No real receiver, browser flow, or deployed application was tested.

Next: migrate phone operations, activity events, poller writes, and remaining shared helpers. Complete shared coordination, import rehearsal, scheduling, streaming/storage, and Vercel acceptance before merging and cutover.
