# phonelink — plan: many phones, hours budget, idle and retention care, webhooks

Status: plan only. Date: 2026-11-07. Builds on `docs/PLAN-WEB.md` (phases 3–7) and does not
replace it. Where this file and PLAN-WEB.md disagree, this file wins for the topics below.

Owner decisions (2026-11-07):

1. Remove the fixed "2 phones max". Users may run as many phones as GitHub lets them.
2. Do **not** build multi-GitHub-account linking now. Document why in code, with doc links.
3. Auto-stop before the hours run out: an **optional** setting, off by default, 30 minutes
   before the estimated end.
4. Offer a 30-minute idle timeout (in addition to 4 h).
5. Show the 7-day retention countdown with a one-click "Keep it".
6. Outgoing webhooks so people can wire phonelink into their own tools.

---

## 0. Summary

The free Codespaces allowance belongs to the GitHub **account**, not to a codespace. More
phones do not give more hours; they spend the same hours faster. So the product stops
pretending there is a phone limit and instead shows an honest **hours budget**: hours left,
how fast they are being used right now, and when they run out at this rate. Everything
else in this plan (auto-stop, idle timeout, retention, webhooks) protects that budget or
reports on it.

Facts this plan relies on (re-check against GitHub docs before Phase M1 ships):

- Included usage is counted in **core-hours** per month (Free ≈ 120, Pro ≈ 180). A 4-core
  machine burns 4 core-hours per hour; a 2-core machine burns 2.
- `POST /user/codespaces` takes `idle_timeout_minutes` and `retention_period_minutes`.
  `PATCH /user/codespaces/{name}` can change `machine` (and display name); idle timeout for an
  existing codespace is not reliably patchable, so it is chosen at create time and stored.
- Retention: GitHub deletes a stopped codespace after its retention period (we set 7 days)
  counted from the last time it was stopped. Starting it again resets the clock.
- GitHub limits how many codespaces a user can have and run. The exact number is not
  something we hard-code: we surface GitHub's own error when it refuses.
- GitHub Terms: one free personal account per person (see section 6).

Docs to cite in code (stable URLs):

- Codespaces billing and included usage:
  https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces
- Idle timeout: https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces
- Retention: https://docs.github.com/en/codespaces/setting-your-user-preferences/configuring-automatic-deletion-of-your-codespaces
- REST API for codespaces: https://docs.github.com/en/rest/codespaces/codespaces
- GitHub Terms of Service (one free account): https://docs.github.com/en/site-policy/github-terms/github-terms-of-service

---

## 1. Many phones (decision 1)

### 1.1 What changes

- Delete the product rule "2 phones max". Remove `PHONELINK_MAX_PHONES` from `.env.local`
  docs and code paths; replace it with an **optional** safety cap `PHONELINK_MAX_PHONES`
  defaulting to unset (no cap). Keep it only as an operator guard for local testing.
- `PHONELINK_MAX_TUNNELS` stays (it protects our relay, not the user).
- Capacity inside one codespace stays as measured: 1 phone per codespace by default
  (2 possible on 4 vCPU, documented as "light use"). "Many phones" = many codespaces.

### 1.2 Creating another phone

Flow on the dashboard ("New phone"):

1. Dialog shows: machine choice (2-core "lasts longer" / 4-core "faster boot", default from
   the user's setting), idle timeout (30 min / 4 h), and the budget line:
   "You have about 22 h left this month. With 2 phones running that is about 11 h."
2. If at least one phone is already running, the primary button says
   "Start another phone" and the dialog adds one sentence:
   "Running phones share your hours, so each extra phone uses them faster."
   No modal "are you sure" beyond this; the sentence is the warning.
3. If GitHub refuses (limit reached, no hours, spending limit 0), show GitHub's message in
   plain words and the one next step (e.g. "Stop a phone, then try again"). Never invent a
   number.

Agent path: `POST /v1/phones` keeps working with no count check of ours; errors from GitHub
are passed through as `{ error: "github_refused", message }` with HTTP 409.

### 1.3 Dashboard with many phones

- Grid of phone cards, running first, then stopped by most recent use. Two columns at
  1440, one at 390. Past 6 phones, switch to a compact list view (name, state, last used,
  retention countdown, actions) with a toggle remembered per user.
- Keyboard: `g 1`…`g 9` open phones 1–9 in the visible order. The command menu lists all
  phones by name (already filters by substring).
- Bulk action: "Stop all running" (safe, no confirm; toast "Stopped 3 phones. Your
  codespaces keep them."). No bulk delete, ever.

---

## 2. Hours budget (makes decision 1 honest)

### 2.1 How we estimate

We cannot rely on GitHub's billing API with only the `codespace` scope, so we estimate
from our own records, and label it "estimated" everywhere:

- New table `runs (phone_id, started_at, stopped_at, cores)`: one row per running period,
  written on our start/stop calls and reconciled by the poller from `GET /user/codespaces`
  state + `last_used_at` (catches stops by GitHub's idle timeout or the user in github.com).
- `used = Σ cores × hours` for runs in the current calendar month (UTC).
- `allowance` = user setting: "Free (120 core-hours)", "Pro (180)", or "Custom". Default
  Free. One-line explanation and a link to GitHub's usage page so they can correct it.
- Phones created outside phonelink do not count (we only see our own), so the copy says:
  "Estimated from phonelink phones only. Your other codespaces use the same hours."

### 2.2 What the user sees

Top of dashboard, replacing the old example quota strip:

- "About **22 h** left this month" (in hours on the user's default machine size).
- When something is running: "2 phones running. At this rate the hours last about **11 h**."
- A thin bar: used / allowance. Turns to the warning colour under 10 %.
- Link: "Check exact usage on GitHub" → https://github.com/settings/billing/usage

API: `GET /v1/usage` → `{ allowance_core_hours, used_core_hours, running: [{id, cores}],
hours_left_at_current_rate, month, estimated: true }`.

---

## 3. Auto-stop before the hours run out (decision 3)

- Setting (Settings → Hours): **"Stop my phones 30 minutes before my hours run out"**,
  off by default. Also exposed as `PATCH /v1/settings { auto_stop_before_empty: true }`.
- The poller (every 60 s, already planned for state sync) computes minutes left at the
  current rate. When ≤ 30 and the setting is on: stop every running phone, write an
  `events` row per phone, fire webhook `hours.auto_stopped`, toast on next page load.
- When ≤ 30 and the setting is off: no stop; fire `hours.low` once per month per threshold
  and show a banner: "About 30 minutes of hours left. Stopping keeps your phones."
- Thresholds for `hours.low`: 20 %, 10 %, 30 minutes. Each fires once per month.
- Stopping is always safe (the codespace keeps the phone), so auto-stop needs no confirm.

Edge cases: estimate is wrong (user has other codespaces) → copy always says "about";
user turns the setting on when already under 30 min → stop on the next tick and say so.

---

## 4. Idle timeout: 30 minutes or 4 hours (decision 4)

- At create time the user picks idle timeout: **30 min (saves hours, recommended)** or
  **4 h**. Default comes from Settings → Hours, default 30 min for new users.
- Passed as `idle_timeout_minutes` to `POST /user/codespaces`; stored in `phones.idle_timeout_min`.
- Phone page shows "Stops after 30 min idle". Changing it later: we try the API; if GitHub
  does not support changing it for an existing codespace, the UI says so and links to
  GitHub's timeout settings page (the user-level default lives there too).
- Note for the agent skill: an agent that is "thinking" for a long time is idle to GitHub
  (no terminal/editor activity). The runner keeps the codespace awake only while it is
  actively driving the phone (tap/type/install calls), so a 30-minute timeout does not
  kill a phone mid-task, but a forgotten phone stops itself.
- Update landing FAQ and console facts: "GitHub stops an idle phone after 30 minutes or
  4 hours, your choice."

---

## 5. Retention countdown and "Keep it" (decision 5)

- Store `phones.last_stopped_at`; `retention_at = last_stopped_at + retention_period`.
  Reconcile from GitHub's `retention_expires_at` when the API returns it.
- Stopped cards show: "GitHub deletes this phone in **5 days** unless you use it." Under
  2 days the line uses the warning colour and the dashboard shows a banner.
- **"Keep it"** button: starts the codespace, waits for `Available`, stops it again. Costs a
  few minutes of hours; the button's description says "Uses about 3 minutes of your hours."
  Shown only when ≤ 2 days left. Also `POST /v1/phones/{id}/keep`.
- Optional setting (off by default): "Keep my stopped phones automatically" → the poller
  runs "Keep it" when 1 day is left. Fires `phone.kept` webhook.
- Webhook `retention.warning` at 2 days and 1 day left.

---

## 6. Multiple GitHub accounts: not now, and why (decision 2)

Not built. Put this reasoning as a block comment at the top of `lib/github.ts` (and a short
pointer in `lib/auth.ts`) so nobody "helpfully" adds it later:

```ts
/*
 * One GitHub account per phonelink user — on purpose.
 *
 * Linking several GitHub accounts to pool their free Codespaces hours would mean one
 * person holding several free accounts, which GitHub's Terms of Service do not allow
 * ("one person or legal entity may maintain no more than one free Account"). That would
 * put users' accounts and our OAuth app at risk.
 *   Terms: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
 *   Codespaces billing: https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces
 *
 * If we add a second account later, it must be one where someone else pays (an
 * organization that bills Codespaces to itself, or the user's own paid usage), never a
 * second free personal account. Re-read the Terms before building it.
 */
```

Also add one line to README "Decisions in one screen": "One GitHub account per user; no
pooling of free accounts (GitHub Terms)."

---

## 7. Webhooks (decision 6)

### 7.1 What users get

Settings → Webhooks: add an HTTPS URL, pick events (default: all), get a signing secret
(shown once, then masked; "Roll secret" button). Each endpoint has a delivery log (last
50: time, event, status code, duration, "Resend").

API mirror: `GET/POST /v1/webhooks`, `PATCH/DELETE /v1/webhooks/{id}`,
`POST /v1/webhooks/{id}/test`, `GET /v1/webhooks/{id}/deliveries`.

### 7.2 Events

| Event | When |
|---|---|
| `phone.created` | codespace created and recorded |
| `phone.starting` | start requested (by user, agent, or Keep it) |
| `phone.ready` | phone booted and adb connected |
| `phone.stopped` | stopped by user, agent, auto-stop, or GitHub idle timeout (`reason` field) |
| `phone.deleted` | user deleted it (typed confirmation passed) |
| `phone.kept` | Keep it ran and the retention clock reset |
| `phone.error` | create/start failed (GitHub message included) |
| `hours.low` | 20 %, 10 %, 30 min left (once each per month) |
| `hours.auto_stopped` | auto-stop stopped phones |
| `retention.warning` | 2 days and 1 day before GitHub deletes a stopped phone |
| `webhook.test` | the Test button |

Payload (JSON, versioned):

```json
{
  "id": "evt_01J…",
  "type": "phone.stopped",
  "version": 1,
  "created_at": "2026-11-07T12:04:00Z",
  "data": {
    "phone": { "id": "ph_7f2a", "name": "phone-7f2a", "state": "stopped", "machine": "4 vCPU" },
    "reason": "idle_timeout"
  }
}
```

Never in payloads: tokens, codespace secrets, runner secrets, stream URLs with secrets.
The codespace name is fine (the user owns it).

### 7.3 Delivery

- Header `phonelink-signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>`,
  plus `phonelink-event`, `phonelink-delivery` (id). Docs include a 10-line verify snippet
  (Node and Python). Reject replays older than 5 minutes in the snippet.
- Outbox table, sent by the poller loop: 10 s timeout, retry with backoff 1 m, 5 m, 30 m,
  2 h, 6 h (5 tries), then mark failed. Disable an endpoint after 3 days of only failures
  and email-free notice in the console.
- At-least-once delivery; receivers dedupe on `id`.
- SSRF guard: HTTPS only in production; resolve the host and refuse private, loopback,
  link-local, and metadata ranges (allow `http://localhost` only when
  `PHONELINK_BASE_URL` is localhost, for local testing). No redirects followed.
- Secrets stored encrypted with the same AES-GCM helper as tokens.

### 7.4 Agent skill

The android-emu skill gets one paragraph: "To be notified instead of polling, ask the
human for a webhook URL and register it with `POST /v1/webhooks`." Agents may still poll.

---

## 8. Data model changes (migration v2)

```sql
ALTER TABLE phones ADD COLUMN idle_timeout_min INTEGER NOT NULL DEFAULT 240;
ALTER TABLE phones ADD COLUMN cores INTEGER;            -- from machine
ALTER TABLE phones ADD COLUMN retention_min INTEGER NOT NULL DEFAULT 10080;

CREATE TABLE runs (
  id         INTEGER PRIMARY KEY,
  phone_id   TEXT NOT NULL REFERENCES phones(id) ON DELETE CASCADE,
  cores      INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  source     TEXT NOT NULL            -- 'phonelink' | 'reconciled'
);
CREATE INDEX runs_phone ON runs(phone_id, started_at);

CREATE TABLE user_settings (
  user_id                 INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  allowance_core_hours    REAL NOT NULL DEFAULT 120,
  default_machine         TEXT,
  default_idle_min        INTEGER NOT NULL DEFAULT 30,
  auto_stop_before_empty  INTEGER NOT NULL DEFAULT 0,
  auto_keep               INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE notices (                 -- once-per-month thresholds
  user_id INTEGER NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, period)
);

CREATE TABLE webhooks (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  events        TEXT NOT NULL,        -- JSON array or '*'
  secret_cipher BLOB NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  failing_since TEXT
);

CREATE TABLE webhook_deliveries (
  id           TEXT PRIMARY KEY,
  webhook_id   TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id     TEXT NOT NULL,
  type         TEXT NOT NULL,
  body         TEXT NOT NULL,
  attempt      INTEGER NOT NULL DEFAULT 0,
  next_try_at  TEXT,
  status       INTEGER,
  duration_ms  INTEGER,
  state        TEXT NOT NULL          -- 'pending' | 'ok' | 'failed'
);
CREATE INDEX deliveries_due ON webhook_deliveries(state, next_try_at);
```

---

## 9. Background work

One in-process loop (`lib/poller.ts`, started from `instrumentation.ts`), every 60 s, per
user with a running or recently stopped phone:

1. Sync state from `GET /user/codespaces` (only our phones; safety invariants from
   PLAN-WEB §7 still apply). Open/close `runs`, emit `phone.*` events on changes.
2. Budget: compute minutes left; fire `hours.low` / auto-stop (§3).
3. Retention: fire `retention.warning`, run auto-keep (§5).
4. Webhooks: send due deliveries (§7.3).

Single process locally, so no distributed lock; guard with an in-memory "running" flag so
ticks never overlap. Every GitHub call respects rate limits (back off on 403/429).

---

## 10. Phases

These slot in after PLAN-WEB Phase 4 (create/start/stop exist), since they need real
mutations.

### M1 — Many phones + budget (6–8 h)
Remove the cap, New-phone dialog with machine + idle choice, `runs` tracking, budget
strip, `/v1/usage`, compact list view, "Stop all running", `g 1…9`.
Accept: create 3 phones in **sutanukaa** (never codewarnab or arnab-naalandaai), see the
budget rate change as they start/stop; GitHub refusal shows GitHub's message.

### M2 — Idle timeout + auto-stop (4–6 h)
Settings → Hours, 30-min default, auto-stop setting, `hours.low` thresholds, banner.
Accept: with a fake low allowance (e.g. 1 core-hour), auto-stop fires at ≤ 30 min and the
phone resumes later with its apps intact.

### M3 — Retention + Keep it (3–4 h)
Countdown, warning colour, Keep it, optional auto-keep.
Accept: unit tests with a fake clock; one real Keep it on a test phone resets the date.

### M4 — Webhooks (6–8 h)
Tables, settings UI, signing, outbox with retries, delivery log, test button, SSRF guard,
docs page with verify snippets.
Accept: a local receiver verifies signatures; a failing receiver gets 5 retries with the
right spacing (fake clock); private-IP URLs are refused.

### M5 — Docs + copy (1–2 h)
Code comment from §6, README line, landing FAQ ("Limits?" answer drops "two phones max",
mentions shared hours and 30-min idle), console facts strip, skill paragraph.

---

## 11. Tests

- Budget math: runs spanning month boundaries, open runs, mixed core counts.
- Threshold notices fire once per month; auto-stop fires once and is idempotent.
- Retention dates from stop times; reconciliation from GitHub fields.
- Webhook signing round-trip, replay window, retry schedule, disable after 3 days.
- SSRF guard: 10.x, 127.x, 169.254.x, ::1, fc00::/7, DNS names that resolve privately,
  redirects refused.
- Safety invariants still hold with many phones (no foreign codespace ever listed or touched).

---

## 12. Copy changes (enforced in review)

- Never "2 phones max". Say "Running phones share your hours."
- Always "about" / "estimated" for hours.
- "GitHub deletes this phone in 5 days unless you use it." — not "we delete".
- "Stopping keeps the phone" stays everywhere.

## 13. Open questions

1. Can `idle_timeout_minutes` be changed on an existing codespace via the API? Verify in
   M2; if not, the UI says "set when the phone is created".
2. Does GET /user/codespaces return `retention_expires_at` for our token? Verify in M3.
3. Should "Keep it" ever run automatically by default? Current answer: no, opt-in.
