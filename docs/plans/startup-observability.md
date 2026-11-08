# Startup observability and private diagnostics

Status: proposed, 2026-11-08. Plan only. No application behavior changed by this document.

## 1. Goal and scope

Explain what startup is doing, where time goes, and which failures repeat.
Collect structured timing data without collecting private phone content or credentials.
Observability is internal tooling for service improvement. Do not expose diagnostic details in the product UI.

Initial scope covers creation, provisioning, setup, Android boot, and the first visible frame.
It also covers keep-awake reliability and unexpected shutdowns during phone use.
Later scope covers broader resume, deletion, retention actions, and ongoing stream reliability.
Do not change retry policy or optimize startup until measurements establish the bottleneck.
Do not introduce an external telemetry service in the first implementation.

## 2. Findings from the source audit

| Source | Current behavior | Gap or consequence |
|---|---|---|
| `lib/phone-mutations.ts` | Stores activity timestamps in `events`; records Android boot duration in message text. | No structured operation or attempt identifier. Durations cannot be queried reliably without interpreting messages. |
| `lib/phone-setup.ts` | Returns `working` or `ready`; background setup writes `setup.log`. | Installation stages are invisible centrally. Failure handling copies a log tail into an exception. |
| `phone/scripts/setup.sh` | Installs runtime libraries, SDK tools, SDK packages, Android CLI, AVD, and scrcpy. | Several commands suppress output. Progress messages lack consistent timestamps and outcomes. |
| `phone/scripts/start-runner.sh` | Starts the runner; writes `/tmp/runner.log`. | No durable, structured start/health timings. |
| `phone/scripts/boot.sh` | Uses Android CLI, then raw emulator fallback. Logs boot details locally. | Central measurements do not distinguish cold boot, snapshot restore, or fallback. Requested resume does not prove snapshot restore. |
| `lib/codespace-tunnel.ts` | Connects through provider metadata, relay, port forwarding, gRPC, SSH, and command execution. | A slow connection appears as one wait. Output is truncated to the last 4,000 characters. |
| `instrumentation.ts`, `lib/poller.ts` | Background reconciliation runs every 60 seconds. Errors trigger one-minute or five-minute backoff. | Errors lack persisted safe categories. Background polling also adds detection latency. |
| `lib/phone-mutations.ts` | Setup checks use a 20-second eligibility delay; failures wait ten minutes. Guards and timers live in memory. | Twenty seconds is not a guaranteed polling interval. Restarts lose retry context and in-memory start guards. |
| `lib/phone-link.ts` | Tries forwarded HTTP, then a tunnel. Sends keep-awake pulses every minute while stream viewers exist. | Pulses depend on stream lifetime. Failures are caught without diagnostics. An open phone page does not prove pulse coverage. |
| `lib/phone-runner.ts` | Keep-awake runs a command through SSH with a terminal. | Command success does not prove that GitHub reset its idle timer. |
| Phone controls and provider reconciliation | Phone input uses the forwarded connection. Reconciliation observes GitHub state changes. | Phone use does not prove provider activity. A shutdown state does not identify its cause. |
| `components/use-phone-video.ts` | Measures FPS and an offset-based delay locally. Reconnects after decoder/socket failures. | First painted frame and reconnect reasons are not persisted. The delay is not a proven end-to-end latency measurement. |
| `lib/phone-screen-api.ts` | Checks session and ownership. Returns generic errors. | Safe counters could explain failures without collecting screenshots or input. |
| `lib/phone-mutations.ts`, `lib/events.ts` | Apply different free-text redaction rules. Webhook output uses explicit fields. | Pattern filtering cannot guarantee that arbitrary errors exclude secrets, paths, or account details. |
| Phone detail page and `AndroidElapsed` | Heading and timer both say “Starting Android.” Badge says `running` while Android boots. | Duplicate wording and mixed meanings of readiness confuse users. |

The screenshot alone does not identify the installation bottleneck.
Gaps between activity timestamps include provider work, scheduling, connection setup, and observation delay.
Historical milestones remain useful, but cannot reconstruct missing installation timings.
The startup audit examined source code without reading private remote logs.
The shutdown investigation also inspected local lifecycle records. Provider-side shutdown reasons remain unavailable.

### Active-use shutdown evidence

The reported phone stopped around 30 minutes after Android became ready.
Local records showed GitHub reporting `ShuttingDown`, without an application stop request for that run.
Those records suggest an idle timeout. They do not prove the cause or identify a failed keep-awake attempt.

GitHub distinguishes Codespace activity from traffic through a forwarded port.
Terminal input or output resets its idle timer. Forwarded traffic alone does not guarantee a reset.
See [GitHub's idle-timeout documentation](https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces).
Verify this behavior during implementation. Do not assume that our SSH command resets the provider timer.

## 3. Questions the measurements must answer

1. How long passes from accepted creation to Android ready and first displayed frame?
2. Which installation step consumes time, and was it executed or already installed?
3. How much delay comes from connection setup, polling, backoff, and retries?
4. Which failure category repeats, and did the next attempt succeed?
5. How do fresh installation, existing installation, and confirmed snapshot restore differ?

For unexpected shutdowns, also answer:

1. Was the phone page open, was its screen connected, and did the server receive phone input recently?
2. Was keep-awake expected, and when did its last attempt start and finish?
3. Did attempts fail, time out, overlap, or stop during reconnection or an application restart?
4. Did PhoneLink request the stop, or did it first observe the stop from GitHub?
5. Does evidence confirm an idle timeout, merely suggest one, or leave the cause unknown?

## 4. Data contract and privacy boundary

Use separate operation and step records in SQLite. Keep existing activity events compatible.
Avoid arbitrary JSON metadata and free-text telemetry messages.

### Operation record

Fields: random operation ID, internal owner ID, internal phone ID, operation kind,
start and finish timestamps, terminal outcome, schema version, instrumentation version,
and coarse application release identifier.

Operation kinds are fixed enums: create, resume, boot retry, stop, delete, and keep.
Add `viewing_session` for bounded keep-awake observation windows during phone use.
Rotate long sessions at a fixed limit. Link windows to the same current phone run.
One operation groups its steps and retry attempts. IDs contain no username or Codespace name.
Internal owner and phone IDs remain private linkage data. They are not anonymous identifiers.
Do not include them in aggregate reports or ordinary server logs.

### Step record

Fields: operation ID, random step ID, parent step ID, producer, producer run ID,
sequence number, fixed step code, attempt number, source start and finish timestamps,
source duration in milliseconds, server observation timestamp, outcome, and fixed error code.

Optional fields are individually defined: HTTP status, retry delay, exit code,
connection route, installation disposition, boot method, and measurement quality.
All strings use bounded enums except generated IDs and validated release identifiers.
Unknown fields are rejected. Unknown errors become `unknown_failure`, without raw text.
Bound record size, batch size, counts, durations, and sequence ranges.

Outcomes: running, succeeded, failed, cancelled, interrupted, skipped, or unknown.
Installation disposition: installed, already_present, or unknown.
Boot method: confirmed_snapshot, confirmed_cold, cli_unspecified, raw_fallback, or unknown.

### Never collect in telemetry

- OAuth/access/refresh tokens, cookies, session hashes, stream tickets, runner secrets, or SSH keys.
- Usernames, emails, repository names, Codespace names, URLs, IP addresses, home paths, or environment dumps.
- Screenshots, video/audio frames, clipboard text, key presses, touch coordinates, app contents, or filenames from the phone.
- Shell commands, request/response bodies, raw exception messages, stack traces, stdout, or stderr.

Generate human-readable labels from fixed codes after validation.
Keep regex redaction as defense in depth, never as the admission policy.
Do not send private diagnostic records through existing webhooks.
Review existing error paths that persist remote log tails; replace them with fixed categories and safe owner-facing messages.
Keep raw local logs outside the telemetry pipeline. Bound and rotate them locally.
Any future raw-log support flow needs a separate, explicit privacy design.

## 5. Lifecycle and timing correctness

Create the durable operation before external work starts. Preserve existing mutation protections.
An uncertain creation remains uncertain; instrumentation must never submit another creation request.
Persist attempt numbers, retry deadlines, and last observed progress.
Use database uniqueness constraints to deduplicate retried delivery.
Allow only one terminal result per step attempt. Do not let stale callbacks finish newer attempts.
Bind updates to operation, attempt, producer run, phone ownership, and expected lifecycle state.
Stop or deletion cancels applicable work. Late telemetry cannot revive a deleted phone.

After restart, reconcile unfinished records with existing remote progress.
Do not declare remote work failed merely because the app process restarted.
Mark the old observer attempt interrupted when appropriate; preserve the remote execution identity.
If evidence is unavailable, report unknown coverage instead of inventing successful completion or exact durations.
Instrumentation failure must not create, restart, stop, or delete a phone.
Use bounded writes and safe telemetry-health counters when storage fails.
Critical lifecycle state remains authoritative even if diagnostics cannot be written.

Use monotonic elapsed clocks within a process. Store UTC timestamps for ordering and display.
Remote scripts must report their own elapsed durations using an available monotonic source.
Do not subtract timestamps from different machines to claim execution duration.
Preserve source completion and server observation separately.
Label polling-derived measurements as observed intervals, not exact provider execution times.
Nested steps overlap: do not sum parents and children to calculate total startup time.

## 6. Stage coverage

| Group | Step codes to instrument | Measurement boundary |
|---|---|---|
| Creation | request accepted, GitHub create request, provider wait | Record API latency separately from time until Available is observed. |
| Connection | metadata fetch, tunnel lookup, relay connect, port wait, SSH server request, SSH authentication | Record fixed stage and route; exclude addresses, keys, payloads, and remote error strings. |
| Setup dispatch | upload files, launch background setup, setup status check | Track connection time separately from remote installation execution. |
| Installation | KVM check, runtime libraries, SDK tools, SDK platform tools, emulator package, system image, Android CLI, AVD, scrcpy verification/download | Record start/end, success/failure, and already-present disposition where verifiable. |
| Runner | launch, health wait | Runner process creation is distinct from a successful health probe. |
| Android | ADB initialization, CLI boot, fallback boot, boot-completed check | Record actual method only when confirmed. Preserve failed CLI attempt before fallback. |
| Screen | stream authorization, connection, first decoded frame, first painted frame, screenshot fallback | Separate backend-ready from owner-browser-visible. Never collect frame content. |

Split the combined `sdkmanager` install into measurable package steps during implementation review.
Check whether that changes dependency resolution or startup cost before adopting it.
If safe separation is unavailable, retain a combined step and state that resolution limit explicitly.
Package installation time includes downloading and extracting until separate evidence exists.
Do not label it “network time” without an independent measurement.

## 7. Collect remote progress without raw logs

Add a small shared script helper that writes versioned structured progress records.
Use a dedicated progress file under a fixed application directory with restrictive permissions.
Keep stdout/stderr in existing local logs; never parse them into central telemetry.
Use fixed event codes, generated attempt IDs, sequence numbers, elapsed duration, and numeric exit codes.
Handle command errors and signals so interrupted steps remain distinguishable from completed work.
Write complete records safely. Recover from a partial final record without losing earlier records.
Cap file size and record count. Reject symlinks and unexpected file locations at the reader boundary.

Extend the existing setup check to retrieve bounded progress batches over the authenticated connection.
Return a typed status object with cursor, progress, freshness, and ready/working/failed state.
Avoid adding a public callback endpoint or a separate ingestion credential.
The server associates the authenticated target with its operation; it never trusts a supplied owner ID.
Treat remote progress as untrusted input even when it comes from the owner's Codespace.
Validate before any database write, server log, internal report, or export.

Persist cursors only after records commit. Duplicate batches must be harmless.
Handle rotation, producer restart, partial reads, missing files, and out-of-order delivery.
If the runner is unavailable, continue using the setup connection for progress.
Once available, a private runner progress endpoint may reduce repeated SSH work.
Keep that optimization separate until connection measurements justify it.

## 8. Internal access and browser measurement

Do not add a Startup details disclosure, diagnostic page, product dashboard,
owner diagnostic read route, or owner support export flow.
Do not expose step timings, retry counts, internal error codes, or telemetry freshness in the product UI.
Keep the removed right-hand activity timers hidden.
Read diagnostic data through a local operator maintenance command with access to the service database.
Provide bounded queries for operation timelines and aggregate performance reports.
Local reports remain private and require the same protected host access as the service database.
Exports omit owner/phone IDs and exact wall-clock times by default.
No remotely accessible admin page or diagnostic API is included.
Do not send telemetry through existing activity events or webhooks.
Preserve the existing external `phone.ready` contract; version any future semantic change separately.

Browser instrumentation can collect first-frame milestones without displaying them.
The timing ingestion route accepts only fixed measurements, not diagnostic read requests.
Require authentication, ownership, same-origin protections, bounded payloads, request limits,
and a server-bound stream attempt ID. Never trust a client-supplied owner ID.
Treat browser reports as untrusted observations, not authority for phone readiness or billing.
Record only first-frame milestones and periodic bounded summary counters, not per-frame events.
First frame is unavailable when no owner opens the screen. Exclude that case from first-frame latency samples.

### Keep-awake and unexpected shutdown diagnostics

Keep these records private under the same access and retention rules.
Observability does not change when PhoneLink keeps a phone awake.
Any keep-awake behavior change requires separate implementation review and provider verification.

**Presence and phone use**

- Record bounded page-presence summaries, visibility, stream attach/detach, and fixed reconnect reasons.
- Treat page presence as a short lease that expires without refresh. An open cached route proves nothing.
- Record only whether the server accepted phone input within a summary interval. Never record individual input events or contents.
- Cover WebSocket controls and HTTP fallback. Do not add a second command just to measure interaction.
- Separate browser-reported presence, server-observed input, stream health, and keep-awake coverage. None proves provider activity.

**Keep-awake attempts**

Record expected cadence, scheduled time, actual start, finish, duration, and fixed outcome for each bounded attempt.
Include viewer count, last success, consecutive failures, and elapsed time since the last success.
Record fixed skip reasons: no viewers, already pending, connection aborted, or observer shutdown.
Separate credential lookup, connection, command completion, timeout, and cancellation failures using safe codes.
Never store the command, credentials, output, or raw errors.

Record when the timer starts and stops, including the last viewer disconnecting.
After an application restart, mark the observation gap explicitly.
Compare expected attempts with recorded attempts so absent pulses remain detectable.
Emit a bounded internal coverage-gap record after two missed one-minute intervals.
Deduplicate repeated gap records and record recovery. Do not create a product toast or wake request.
Retain bounded attempt details and interval summaries so long sessions cannot exceed record caps silently.
Expose dropped-record counts and missing coverage in operator reports.

**Stop attribution**

Persist application stop intent before the provider request, with operation ID and fixed initiator code.
Initiators distinguish owner action, stop-all, hours-budget policy, and other supported application policies.
Record request outcome separately. A failed or uncertain request does not prove that PhoneLink caused a later stop.
Link stop evidence to the current phone run. Never reuse a previous run's `stop_reason`.

At the first observed provider stop, preserve the preceding observation window before connections disappear.
Include effective idle timeout, source and freshness, last observed provider activity if available, and safe provider state.
Do not fetch raw remote logs or add unbounded provider polling.
Missing permissions or unsupported provider fields produce explicit unavailable evidence.

Store observation source separately from cause and confidence.
Use fixed causes: `application_stop`, `provider_idle_timeout`, `provider_other`, or `unknown`.
Use fixed confidence: `confirmed`, `suspected`, or `unknown`.
Confirm provider causes only when authoritative provider evidence explicitly identifies them.
Matching timeout timing supports a suspected idle timeout. It never proves one.
A `ShuttingDown` state alone means only that GitHub reported a stop.
Successful keep-awake commands alone do not prove that GitHub recognized activity.

**Operator report**

Provide one bounded timeline for the phone run and its unexpected stop.
Show presence, recent accepted input, screen reconnects, keep-awake attempts, coverage gaps, and application stop intent.
Show provider observations and their freshness beside the configured idle timeout.
End with the attributed cause, confidence, supporting evidence, and missing evidence.
Default exports still omit owner/phone IDs and exact wall-clock times.

The duplicate “Starting Android” wording is a separate product-copy fix.
Its proposed presentation is one heading, “Starting Android,” with “2:22 elapsed” beneath it.
The ambiguous `running` badge also needs a separate readiness-copy decision.
Neither UI fix is required for internal observability. Do not bundle them into this implementation.

## 9. Reports, retention, and operational cost

Use local SQLite summaries initially. An external collector can follow if operational need justifies it.
Report count, failure rate, median, and 95th-percentile duration per stage and release.
Show sample count and measurement quality. Label small samples as insufficient for conclusions.
Separate fresh setup, existing installation, confirmed snapshot, cold boot, and unknown boot method.
Also report retry wait, observation delay, stale operations, telemetry write failures, and collector failures.
Report unexpected stops, keep-awake failures, coverage gaps, and stops during recent server-observed phone use.
Separate confirmed causes from suspected causes and unknown causes in every aggregate.
Report incomplete attempts separately so successful samples do not hide timeouts.
Keep metric dimensions bounded; exclude identifiers and arbitrary error text.

Proposed defaults: detailed records for 14 days and daily aggregates for 90 days.
Retain bounded terminal summaries only for internal diagnosis within the documented retention window.
Apply access and retention rules to backups and exported reports too.
Account deletion removes linked records. Phone deletion cancels active records and keeps only the documented diagnostic window.
Use bounded pruning batches and indexes on owner, operation, status, and retention timestamps.
Measure database growth, write overhead, collector latency, and extra provider requests during rollout.
Set hard per-operation record caps before enabling collection.

## 10. Delivery phases and acceptance gates

1. **Contract and privacy boundary — approximately one working day.**
   Add typed codes, validation, SQLite migration, retention rules, and protected local operator reading.
   Gate: unknown/free-text fields cannot reach storage or output. Product routes cannot read diagnostic records.

2. **Lifecycle and connection measurements — approximately one working day.**
   Instrument operations, attempts, scheduling, API calls, and connection substeps.
   Persist stop intent and distinguish provider observations from confirmed shutdown causes.
   Preserve product UI and activity output. Keep telemetry in its separate internal store.
   Gate: restart, retry, cancellation, and deletion preserve truthful operation outcomes.

3. **Remote setup and boot progress — approximately two working days.**
   Add structured script progress, bounded collection, cursors, and actual boot-method evidence.
   Gate: a long setup identifies its active step even before the runner is ready.

4. **Internal reports, screen measurements, and keep-awake diagnostics — approximately two working days.**
   Add safe local operator reports and background first-painted-frame reporting, without product UI additions.
   Add presence summaries, keep-awake attempts, coverage gaps, and unexpected-stop timelines.
   Gate: private content never enters telemetry; missing browser samples remain explicitly missing.
   Gate: explain active-use shutdown evidence without treating command success as a confirmed idle-timer reset.

5. **Isolated validation and controlled rollout — approximately one to two working days.**
   Validate synthetic failures first, then one authorized disposable Codespace lifecycle.
   Gate: explain the measured startup timeline, verify privacy, and document collection cost before broad enablement.

Estimates assume existing authentication and transport remain suitable. Revise after phase one.
Each phase should produce a reviewable change. Do not bundle unrelated performance optimizations.

## 11. Verification strategy

Follow the test-audit authoring gate. Extend existing boundary coverage before adding overlapping tests.
Use synthetic secrets and private-looking values; never test using stored real credentials.

- Privacy contract: nested unknown data, token formats, URLs, headers, log fragments, and command output are rejected or omitted.
- Access contract: product routes cannot read telemetry; browser ingestion rejects timing reports for another owner or phone.
- Persistence contract: duplicate delivery, restarts, retry races, partial progress files, cancellation, and stale callbacks keep correct outcomes.
- Measurement contract: exact, observed, missing, and interrupted durations remain distinct; nested durations are not double-counted.
- Failure contract: disk/write failure, invalid remote records, lost connections, and unavailable collectors cannot replay mutations or block cancellation.

Run shell and runner checks inside a verified disposable Linux sandbox with minimal mounts and credentials.
On Windows, do not execute untrusted installation scripts on the host.
If isolation is unavailable, leave those execution checks pending and report the limitation.
For real acceptance, use a dedicated disposable Codespace only after execution is authorized.
Clean up created resources without affecting existing phones.

Acceptance evidence must show fresh setup, existing setup, failed step plus retry,
app restart during remote setup, stop/delete during setup, and first painted frame where supported.
Compare safe measured totals against an independent stopwatch within documented observation uncertainty.
Inspect captured telemetry artifacts using synthetic privacy canaries before enabling collection for real users.

### Keep-awake and shutdown acceptance

1. Simulate active phone use with failed or hanging keep-awake attempts. The report must expose failures and missing coverage.
2. Simulate reconnects, hidden pages, expired presence leases, multiple viewers, and application restarts. Preserve uncertainty across each gap.
3. Simulate owner stops, stop-all, budget stops, and provider-only stops. Attribute each using current-run evidence.
4. Verify bounded collection, privacy, retention, and safe operation when telemetry writes fail. Never retain actual input content.
5. With authorization, use one disposable Codespace beyond its configured idle timeout while actively controlling the phone.

For the real check, record the effective timeout and verify whether our keep-awake transport resets provider activity.
Also observe an authorized idle control period without keep-awake. Record actual behavior and provider evidence availability.
Use a shorter supported timeout where practical. Bound runtime and clean up the disposable Codespace afterward.
Do not disable keep-awake or force a shutdown on an existing user phone for this check.
An unknown provider cause must remain unknown when authoritative evidence is unavailable.
Historical shutdowns cannot gain missing heartbeat evidence retroactively.

## 12. Rollout and limits

Enable collection behind a server setting, starting with one owned test phone.
Old runners report coarse coverage until upgraded; never claim historical detail exists.
Keep the old setup status contract compatible during deployment.
Disabling collection must stop new diagnostic writes without affecting phone operation.
Keep schema changes additive so disabling instrumentation requires no destructive rollback.

This design identifies slow stages. It cannot automatically prove their root cause.
A slow SDK installation could involve download speed, extraction, storage, or package checks.
Add resource measurements later only when a specific bottleneck warrants them.
Do not collect process lists, filesystem contents, network destinations, or phone content to fill that gap.

Execution remains pending user approval of this plan. No implementation or push is included in this planning task.
