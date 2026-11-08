# Private startup diagnostics

Implementation: additive schema version 9. Collection defaults to disabled.
Isolated runtime validation and disposable-Codespace acceptance are pending.
The product UI and the external `phone.ready` contract stay compatible.

## Setup failure state

`phone_setup_attempts.failed` stores setup failure independently of diagnostic collection.
Phone lists and detail reads expose it as `setup_failed`; cards and the phone screen use that field.
`state_detail` supplies display text only. Editing that text cannot set or clear a failure.
Starting a retry clears `failed`; successful setup and stopping remove the attempt.
Failed attempts and their retry deadlines survive a server restart.

This uses existing storage and needs no migration or message-based backfill.
Records without an attempt report `setup_failed = 0`, including old records with failure-like display text.
Their next setup check records the current result explicitly.

## Enable after acceptance

Set these server settings for one owned disposable test phone:

```dotenv
PHONELINK_DIAGNOSTICS=1
PHONELINK_DIAGNOSTICS_PHONE=phone-0123456789abcdef
PHONELINK_RELEASE=0123456
```

`PHONELINK_RELEASE` accepts a lowercase Git revision with 7–40 hexadecimal characters.
Invalid or absent revisions become `unknown`.
Unset the phone filter only after reviewing acceptance evidence and collection cost.
Setting `PHONELINK_DIAGNOSTICS=0` stops central diagnostic writes and browser attempt issuance.
Already-running remote scripts can finish writing their bounded local progress file.
No telemetry setting creates, starts, stops, or deletes a phone.

## Local operator reports

Run from the service checkout, using the same protected host access as the database:

```sh
node scripts/diagnostics.ts .data/phonelink.db list
node scripts/diagnostics.ts .data/phonelink.db timeline <operation-id>
node scripts/diagnostics.ts .data/phonelink.db aggregate
node scripts/diagnostics.ts .data/phonelink.db health
```

The reader opens SQLite read-only. It does not load credentials or migrate the database.
`list` returns up to 50 opaque operation IDs for selecting a timeline.
`timeline` returns up to 500 records linked to that operation's phone run.
Exports omit owner IDs, phone IDs, producer IDs, exact timestamps, and arbitrary text.
Keep reports and database backups under the database's access and retention policy.
There is no remote diagnostics read route, dashboard, or support export.

Timelines show server observation offsets separately from source durations.
Remote source clocks are never subtracted from server clocks.
Nested steps overlap. Do not sum them to calculate total startup time.
Provider waits have an observed duration only when the original observer survives.
After a restart, unavailable execution durations remain missing.
First paint means a visible canvas submission followed by two animation callbacks.
It is a browser observation of a rendering opportunity, not physical display confirmation.
Absent browser reports remain missing and do not enter successful first-frame samples.

Aggregates include counts, failures, incomplete attempts, sample quality, and duration percentiles.
Percentiles are logarithmic bucket upper bounds, rather than exact millisecond values.
Groups include release, stage, installation disposition, boot method, shutdown cause, and confidence.
Fewer than 20 samples are labelled insufficient.
Health counters cover rejected records, collector failures, dropped records, and write failures.
Counters flush during maintenance; a crash during database failure can lose unflushed counts.

## Admission and lifecycle

The contract admits only fixed codes, bounded numeric fields, generated IDs, and validated timestamps.
Unknown fields and free text cannot enter diagnostic storage or reports.
The SQLite `record` column contains that validated contract, not arbitrary metadata.
Raw stdout, stderr, exceptions, commands, credentials, addresses, and phone content are excluded.
Activity events and webhooks do not carry diagnostic records.
Setup and boot errors use fixed owner-facing messages.

Operations begin before provider mutations. Unconfirmed creation is reconciled without another POST.
Setup attempts have durable retry deadlines and unique attempt IDs.
Polling backoff also survives restarts. Retry intervals remain unchanged.
Stop and deletion cancel applicable records. Stale completions cannot overwrite terminal results.
Server observer attempts become interrupted after restart. Remote execution identities remain intact.
Viewing windows rotate after 15 minutes and link to the current phone run.
Account deletion cascades through linked diagnostic records.

Each operation holds at most 2,048 steps. Excess records increment dropped counts.
Remote batches hold at most 32 records and 24 KiB of source lines.
Each record is at most 2 KiB. Each progress file is at most approximately 1 MiB.
Progress uses a per-operation directory under `$HOME/phonelink/.progress` with private permissions.
The reader rejects symlinks, non-regular files, wrong owners, and unexpected operation paths.
Partial final lines remain unread until complete. Malformed complete lines are dropped.
Delivery deduplicates by step identity and producer sequence.
The cursor advances only after admitted records commit; invalid records are counted and discarded.
Local setup, runner, and emulator logs rotate at 1 MiB and never enter telemetry.

Detailed central records expire after 14 days. Anonymous daily aggregates expire after 90 days.
Maintenance prunes at most 100 operations and 500 daily buckets per invocation.
Phone deletion preserves only that bounded central diagnostic window.
Local progress belongs to the disposable Codespace and disappears with it.

## Keep-awake and shutdown interpretation

Keep-awake cadence and viewer eligibility remain unchanged.
Records separate credentials, connection stages, command completion, timeout, skips, and coverage gaps.
Two missed one-minute intervals produce one gap record. A later success records recovery.
Restart records mark unknown coverage rather than claiming continuous pulses.
Browser presence lasts 75 seconds without refresh.
Accepted input is a bounded boolean summary; it contains no keys, coordinates, text, or clipboard data.
The runner adds this boolean to existing WebSocket heartbeats. HTTP input records success after its existing command.

Stop intents distinguish owner, stop-all, hours-budget, and retention requests.
An observed provider stop has a separate record. Prior-run stop intent cannot attribute a new run.
Without authoritative provider evidence, provider causes remain `unknown`.
Configured timeout and available provider activity timestamps do not establish an effective organization timeout.
The report explicitly lists unavailable provider cause and idle-reset evidence.

GitHub documents terminal input/output as activity; forwarded-port traffic alone does not guarantee activity.
The specific SSH keep-awake transport still needs the disposable live check below.
Source: [GitHub idle-timeout documentation](https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces).

## Acceptance before rollout

1. Run `pnpm test`, shell checks, and runner checks in a verified disposable Linux sandbox without credentials or network access.
2. Exercise fresh setup, existing setup, failed setup plus retry, restart during setup, and stop/delete during setup.
3. Exercise first paint, screenshot fallback, hidden pages, reconnects, multiple viewers, expired presence, and failed/hanging pulses.
4. Inspect exports with synthetic privacy canaries. Check write failures, record caps, cursor replay, retention, and account deletion.
5. Authorize one disposable Codespace for timed startup and activity/idle control periods. Clean it up afterward.

Compare startup observations with an independent stopwatch and document polling uncertainty.
Record effective idle timeout and verify whether the actual SSH transport resets provider activity.
Measure database growth, write overhead, collector latency, and extra provider requests.
Each setup status check reuses its existing authenticated connection to collect progress.
Setup returns a typed internal state, committed cursor, validated progress, and observed/unavailable freshness; legacy remote status markers remain compatible.
Upload timing starts after the small progress helper is available; connection and command timings include its transfer.
One bounded, read-only SSH collection after successful or failed boot retrieves final boot progress without delaying Android readiness.
Browser attempts renew after 15 minutes through the existing ticket issuer, including screenshot-only browsers; renewal does not open a stream or change keep-awake policy.
SDK package installation remains combined until isolated comparison verifies that splitting preserves dependency resolution.
It includes downloads, extraction, and package checks; it is not labelled network time.
Old runners retain coarse measurements until upgraded. Historical detail cannot be reconstructed.
