# Turso compatibility results

Verified 2026-11-08 from the local Windows machine, using `@libsql/client@0.18.0` through its web entry point. The user explicitly authorized local execution without a disposable runtime. Dependencies were installed in a temporary directory with lifecycle scripts disabled. No application dependencies or production code changed.

## Confirmed compatibility

Eight checks passed against the user-provided empty hosted test database:

1. All nine migration SQL batches created the expected 23 application tables, using a separate migration-history table.
2. Generated integer user IDs and binary ciphertext round trips retained the expected values.
3. Invalid foreign keys were rejected without inserting a session.
4. Interactive transactions supported dependent reads, rollback, and commit.
5. A foreign-key failure rolled back an earlier write in the same batch.
6. Two independent clients competing for the same notice produced exactly one inserted row.
7. The existing targetless `poller_retries` upsert updated the existing row.
8. The actual webhook fan-out statement from `lib/data/events.ts` worked, including JSON membership and generated delivery IDs. Date arithmetic and hidden-rowid ordering worked. Competing conditional delivery claims produced exactly one affected row.

## Confirmed incompatibility

The hosted endpoint rejected `PRAGMA user_version = 1` with `SQL_PARSE_ERROR: SQL not allowed statement`. Reading the PRAGMA succeeded. The existing migration runner therefore cannot be reused unchanged. A migration-history table worked in the successful probe.

The initial probe also split a semicolon inside a SQL comment incorrectly. This was a probe defect, not a database incompatibility. Stripping line comments before splitting the current migration SQL corrected it. This lightweight extraction is scoped to the current nine migrations, not a general SQL parser.

## Cleanup and remaining limits

All synthetic schema tables were removed after the successful run. The hosted database itself remains available to the user.

These results support proceeding with Turso/libSQL. They do not prove a completed migration or Vercel deployment. The application still uses synchronous DatabaseSync calls. Shared OAuth refresh leases, full phone-operation concurrency, application-level transaction propagation, and deployment-region latency remain unverified. Local checks do not establish Vercel-region performance. No production data was read or copied.

Reproduction script: `scripts/verify-turso.mjs`. Run against an empty dedicated database only, with URL and token delivered as credential files. Install the pinned client in a separate working directory with `--ignore-scripts`; mirror the script and its two SQL source inputs there. Do not log credential file contents.
