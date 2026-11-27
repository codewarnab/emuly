# Viewing session outcomes

A viewing session is a `diagnostic_operations` row with `kind = 'viewing_session'`. It records one person watching one phone in the browser.

## The old problem

On 27 Nov 2026, 86 of 113 viewing sessions in 8 hours had the outcome `interrupted`. In 75 of the 86, no step failed. Most of these sessions were normal.

The cause:

1. The open session lives in the memory of one Vercel instance (the `viewing` map in `lib/phone/phone-observation.ts`).
2. That instance closes the session as `succeeded` only when it gets another request after the 15-minute window.
3. Vercel stops instances at any time. Then nothing closes the session.
4. After `ABANDONED_AFTER_MS` (6 minutes), another instance ran `reconcile()`. It added `observer_restart` and `coverage_gap` steps and set `interrupted`.

So `interrupted` meant "the Vercel instance went away". It did not mean "the user had a problem".

## The rule now

`closeQuietViewingSessions()` in `lib/diagnostics/diagnostics.ts` runs in each `reconcile()`. It closes a viewing session that got no step for `ABANDONED_AFTER_MS`. It uses only the stored steps, so any instance can close any session.

| Stored steps | Outcome |
|---|---|
| A server step is still `running` | `interrupted` (work was cut off). The running steps also become `interrupted`. |
| A step `failed` | `failed` |
| Other | `succeeded` (the viewer left) |

A quiet session gets no `observer_restart` or `coverage_gap` step. A quiet end is the normal end, not a gap.

While the browser is visible, it sends a `presence` step about every 30 seconds. So an active session does not go quiet.

## How to read the numbers

- Real problems are `failed` sessions. Look at the failed step, for example `forwarded_probe` with `provider_unavailable`.
- Rows from before this change keep the old `interrupted` outcome. Do not compare them with new rows.

## Known gap

The server also opens a viewing session for requests with no browser viewer, such as agent calls to `links` or `proxy`. On 27 Nov, 58 of 86 sessions had no browser step. These sessions now end as `succeeded`, so they make the success rate look higher than it is. To count only real viewers, filter on sessions that have a `browser` step.
