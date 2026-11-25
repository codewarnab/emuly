# Diagnostics overhaul plan

Status: Parts 1, 2 and 3 are done. Part 2 added the "states" report mode and 180-day retention for diagnostic_states. Parts 4, 5 and 6 are not started.

## Why

The diagnostics system in `lib/diagnostics/` works, but it gives us almost no data:

- `EMULY_DIAGNOSTICS_PHONE` limits recording to one phone. The phone was deleted on 14 Nov 2026, so nothing has been recorded since.
- `diagnostic_health` shows 597 `writeFailures`. We cannot see why, because the code drops the error.
- It records phone lifecycle steps only. It does not record how agents use the `/v1` API.
- Some rows keep `owner_id` and `phone_id`. That is more than we need to improve the product.

## Goals

1. **Fully anonymous.** No row can be linked to a user, a GitHub account, an agent key, a phone, an IP or a time to the second.
2. **On for all phones.** No single-phone filter in production.
3. **Phone states and errors.** How long each state and step takes, and how often each one fails, and with which error.
4. **Agent API usage.** Which `/v1` routes agents call, how often, how fast, and which calls fail or are retried.
5. **Never breaks or slows the product.** A diagnostic failure never changes a response. No user or agent request waits for a diagnostic write. Writes go to a background queue, and `waitUntil` keeps the Vercel function alive until they end.
6. **Comments in the code.** Each recording point says what it records and why it is anonymous.

## Anonymity rules

These rules apply to every new table and every record. A review fails if a change breaks one.

| Rule | How |
|---|---|
| No user, phone or key IDs | Do not store `user_id`, `owner_id`, `phone_id`, `agent_key_id` or codespace names. |
| No linking between rows | Do not store a stable per-user or per-phone hash. A random `run_id` lives only in memory for one phone life, and is never written next to an ID. |
| No content | No request bodies, adb commands, app names, package names, URLs with values, notes, screenshots or error text. Only codes from a fixed list. |
| No IPs, no region from IP | Do not record IPs. Region is the Codespace region only (`centralindia` etc.), which is shared by many users. |
| Coarse time | Store the UTC day only, never the time of day. |
| Counts, not events | Write into daily counters with time buckets. Do not write one row for each call. |
| Small groups hidden | A report hides any group with fewer than 10 samples on that day. |
| Route templates only | Store `/v1/phones/:id/adb`, never the real path. |

Because nothing links to a person, these tables need no `seal` encryption and no entry in `lib/auth/reencrypt.ts`. The account delete path needs no change either.

## Part 1: Fix what exists

1. **Remove the single-phone filter.** Delete the `EMULY_DIAGNOSTICS_PHONE` check from `allowed()` in `lib/diagnostics/diagnostics.ts`. Remove the variable from Vercel. Update `docs/startup-diagnostics.md`.
2. **Find the write failures.** The `catch {}` in `createDiagnostics` drops the error. Keep a counter for each error *class* (`constraint`, `busy`, `timeout`, `validation`, `other`) in `diagnostic_health`, for example `writeFailures.constraint`. Do not log the message. It can hold IDs.
3. **Make the records anonymous.** Add a new migration. It drops `owner_id` and `phone_id` from `diagnostic_operations`, and drops the `diagnostic_phone_runs` table. The phone-to-run mapping moves to memory and to the `phones` row, which is deleted with the phone anyway. Delete the 15 old rows, because they hold IDs.
4. **Fill `diagnostic_daily` fully.** Today the `cause`, `boot_method` and `disposition` columns are always `unknown`. Pass the values that the steps already have.

## Part 2: Phone states and errors

Add one new daily counter table, `diagnostic_states`:

```sql
CREATE TABLE diagnostic_states (
  day TEXT NOT NULL,            -- UTC day, 2026-11-25
  release TEXT NOT NULL,        -- git short SHA
  from_state TEXT NOT NULL,     -- creating, starting, running, stopping, stopped, failed
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,         -- fixed code: owner, agent, idle, hours_budget, provider, error
  error_code TEXT NOT NULL,     -- from errorCodes, 'none' on success
  region TEXT NOT NULL,         -- codespace region or 'unknown'
  bucket_ms INTEGER NOT NULL,   -- time in from_state, power-of-2 bucket
  samples INTEGER NOT NULL,
  PRIMARY KEY(day, release, from_state, to_state, reason, error_code, region, bucket_ms)
);
```

- Record one row increment at each state change in `lib/phone/phone-mutations.ts`, `poller.ts` and `reconcile.ts`.
- Add error codes we see today but cannot name: `github_quota`, `github_auth`, `kvm_missing`, `boot_timeout`, `runner_crash`, `tunnel_lost`.
- This answers: How long does a cold start take? How often does a start fail, and why? How often does the idle stop fire?

## Part 3: Agent API usage

Add one new daily counter table, `diagnostic_api`:

```sql
CREATE TABLE diagnostic_api (
  day TEXT NOT NULL,
  release TEXT NOT NULL,
  route TEXT NOT NULL,          -- template, e.g. POST /v1/phones/:id/adb
  client TEXT NOT NULL,         -- cli, skill, browser, other (from User-Agent, fixed list)
  client_version TEXT NOT NULL, -- major.minor of emuly CLI or skill, or 'unknown'
  auth TEXT NOT NULL,           -- agent_key, session, none
  status_class TEXT NOT NULL,   -- 2xx, 4xx, 5xx
  error_code TEXT NOT NULL,     -- fixed code from the response body, 'none' on success
  bucket_ms INTEGER NOT NULL,   -- server time, power-of-2 bucket
  samples INTEGER NOT NULL,
  PRIMARY KEY(day, release, route, client, client_version, auth, status_class, error_code, bucket_ms)
);
```

Also add a small counter for **call patterns**, still with no IDs:

- `diagnostic_api_patterns(day, pattern, samples)`, where `pattern` is a fixed code:
  - `poll_after_wait`: a status poll within 2 s of a call that already waits.
  - `retry_same_route`: the same route again within 5 s after a 4xx or 5xx.
  - `screenshot_burst`: more than 10 screenshots in 60 s.
  - `unknown_route`: a call to the 404 handler in `app/v1/[...path]/route.ts`.
  - `old_client`: a CLI or skill version below the current one.
- The detector keeps a short in-memory window per agent key. The window never goes to the database, and it ends with the function.

How to record it:

- One wrapper around each `/v1` handler, in `lib/api.ts`, so each route gets it with no extra code.
- The wrapper reads the route template, the status and the time after the response is built. It writes the counter **after** the response, with `after()` from Next, so it adds no latency.
- The counter write is an upsert: `INSERT ... ON CONFLICT DO UPDATE SET samples = samples + 1`.
- To save Turso writes, batch counters in memory and flush once per request end, or every 10 s.

This answers: Which routes do agents use most? Which ones fail? Do agents poll when they could wait? Do they use old CLI versions? Which errors make agents retry?

## Part 4: Reports

- Add `api`, `states` and `patterns` modes to `lib/diagnostics/diagnostic-reports.ts`.
- Each mode hides groups with fewer than 10 samples.
- Add a script, `scripts/diagnostics-report.ts`, that runs the reports against Turso with a short-lived token, like `scripts/migrate-database.ts`.
- Later, maybe: an admin page. Not part of this plan.

## Part 5: Retention and cost

- Keep daily counters for 180 days. Keep step detail (`diagnostic_steps`) for 14 days.
- Delete old rows in the existing scheduler run in `lib/phone/scheduler-parts.ts`.
- Expected size: about 200 routes × 4 clients × 10 buckets × 3 status classes. That is a few thousand rows a day at most, which is small for Turso.

## Part 6: Code comments

Each recording point gets a short comment in this form:

```ts
// Diagnostics (anonymous): counts this state change by day, reason and time bucket.
// No user, phone or key ID is stored. See docs/diagnostics-overhaul-plan.md.
```

The top of `lib/diagnostics/diagnostics.ts` gets a block comment with the anonymity rules table, in short form.

## Tests

- A test that writes every record type, then reads every diagnostic table and checks that no column holds a value matching a user ID, phone ID, agent key ID, IP or full timestamp.
- A test that a thrown error in a diagnostic write does not change the API response.
- A test that the `/v1` wrapper stores the route template, not the real path.
- A test that reports hide groups with fewer than 10 samples.

## Order of work

1. Part 1 (fix, anonymize, remove the filter). One migration.
2. Part 3 (agent API usage). This gives the most new data.
3. Part 2 (states and errors).
4. Parts 4 and 5 (reports and retention).
5. Migrate production before each push that reads a new table (see `AGENTS.md`).

## Open questions

- Do we want `region` at all, while there are few users in some regions? The 10-sample rule hides small regions, but we can also drop it.
