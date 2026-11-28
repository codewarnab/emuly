# Plan: errors that say what to do, hints, skill updates, and the phone window

Status: Phase 1 is built (branch `agent-errors-fix`, commit `1231aab`). Phases 0, 2 to 5 are not started. Decisions marked **ASK** need the user's choice before that step starts.

Emuly is mostly used by agents. So every step below is judged by one question first:
**can an agent act on this without reading prose or asking the user?**

> Code base note: this plan was written against `e6b4197`. `origin/main` already has 2 newer commits.
> `439a3fd` adds boot progress plus "a note and hint after 5 min" to phone reads. Rebase on main before
> Phase 1 and reuse that hint shape if it fits.

This plan continues Part 2 of `docs/vercel-and-response-hints-plan.md` (steps H1 to H9). That plan already
picked a structured `fix` object. This plan turns it into one shared format and adds the skill and
phone-window work.

---

## What we found (code search)

| Area | What is there | File |
|---|---|---|
| Error shape | `{ error, message }`, one helper | `lib/http.ts:14` (`apiError`), `lib/http.ts:22` (`errorResponse`) |
| Error sites | ~142 `json({ error … })` / `apiError(` calls in `lib/` and `app/` | many |
| Copied text | `phone_not_ready` text is copied 11 times | `lib/phone/phone-agent-api.ts:292, 362, 390, 421, 547` and more |
| No help text | `unauthorized` has no message | `phone-agent-api.ts:193, 211, 227` … |
| Already good | start and stop return a `wait` URL | `phone-agent-api.ts:199` |
| Already good | `timeout` gives `retry_after` and `Retry-After` | `phone-agent-api.ts:185` |
| Pattern detector | finds `poll_after_wait`, `retry_same_route`, `screenshot_burst`, `unknown_route`, `old_client`. It only **counts** them and never tells the agent | `lib/diagnostics/api-usage.ts:88-107` |
| **Bug** | `old_client` never fires. The skill now sends a 12-hex hash in `X-Emuly-Skill`, but `clientOf` expects a date (`2026-11-25.2`), so the version is always `unknown` | `api-usage.ts` `clientOf`, `api-usage.ts:91` |
| Skill update | `skill_update` is sent only on `GET /v1/phones` | `lib/skill-update.ts:20`, `phone-agent-api.ts:215` |
| Skill update | the command holds `<your agent id>` and `<your skills folder>` placeholders | `lib/skill-update.ts:31-33` |
| Phone window | the user copies `irm …/open/<id>.ps1 \| iex` or `curl … \| sh` into a terminal | `components/phone/phone-screen.tsx:62` |
| Phone window | the 383-line script installs gh and scrcpy, opens an SSH tunnel (up to 90 s, 3 tries), waits up to 180 s for Android, and the terminal must stay open | `content/open/open.sh:322-383` |
| Phone window | a popup after 45 s of live video pushes the window | `phone-screen.tsx:248-280, 379-388` |

## What we found (web search)

- **RFC 9457 (Problem Details)** is the standard error envelope (`type`, `title`, `status`, `detail`,
  `instance`, plus your own extra fields). It says nothing about agents. A "next step" field is our own
  documented extension. Advice from API vendors: keep codes stable, never reuse a code for a new meaning,
  and give retry limits and backoff explicitly. Do not echo secrets or say which permission was missing.
- **Document Picture-in-Picture** (a small always-on-top browser window that can hold any element,
  including our canvas) works in Chrome and Edge 116+ and in Firefox 151+ (May 2026). Safari and all
  mobile browsers don't have it, so we need a fallback.
- **`npx skills`** has `check` and `update`, but `-a <agent>` is documented only for `add` and `ls`. Local
  installs can't be checked for updates. So we can't rely on `npx skills update -a …`. Check
  `npx skills update --help` on the current version before Phase 3.

---

## Phase 0: fix what the later phases depend on (small)

1. **Fix `old_client` detection.** Accept the 12-hex skill hash in `clientOf` and compare it with
   `skillVersion()` instead of a date. Keep the old date format so older skills still count.
2. **Fix the lost diagnostic writes** (H9 in the old plan: 3633 lost writes). Without this we can't
   measure whether the hints work.
3. **Save a baseline**: `diagnostic_api` grouped by client, error code and pattern for 2 days.

Done when: `old_client` shows up in the counts and write failures are near 0.

## Phase 1: one error format with a `fix` (high impact, low to medium effort)

**Status: built on branch `agent-errors-fix` (`1231aab`).** The user chose "keep ours, add `fix`" and the shared route wrapper.
- Done: `lib/agent-help.ts`, called from `withApiUsage`, adds `fix`, `retry_after`, `max_retries`, `needs_user` and `use_cli` to every `/v1` JSON error.
- Done: state-aware `phone_not_ready` (5 copies in `phone-agent-api.ts` and the one in `phone-links-api.ts`).
- Done: `unauthorized` reason and fix; `not_found`, `runner_update_required`, `busy`, `timeout`, `request_failed` and `rate_limited` help.
- Done: `use_cli` for callers that are not the CLI or the browser (sh or PowerShell install line).
- Done: device sign-in `interval` and fix; setup-code messages.
- Done: CLI prints `emuly: next: <fix>` on stderr. Skill section "When a call fails"; `AGENT_RUNBOOK_VERSION` 2026-11-28.1.
- Done (Phase 0 items): `clientOf` no longer counts PowerShell as a browser; `old_client` works with skill hash versions.
- Tests: `lib/agent-help.test.ts` (each `fix.path` must be a real `/v1` route). Lint, 622 tests and build pass.
- Not done: `github_refused` reasons, `invalid_input` `field`/`allowed`, the state-aware `phone_not_ready` in the apps, stream and diagnostics APIs, `docs` links, `if_fix_fails` for the timeout `ran: "unknown"` case.
- Not done: checking it against a live phone.

**Format** (keeps today's fields, so old clients don't break):

```json
{
  "error": "phone_not_ready",
  "message": "The phone is stopped. Start it, then wait for ready.",
  "fix": { "method": "POST", "path": "/v1/phones/p-1/start", "then": { "method": "GET", "path": "/v1/phones/p-1?wait_for=ready&timeout_s=60" } },
  "retry_after": 5,
  "docs": "https://emuly.xyz/.well-known/skills/emuly-playbook/references/delete-and-errors.md#phone_not_ready"
}
```

Rules:
- `error` stays the stable code. `message` stays one plain sentence. `fix` is optional. Send it only when
  the agent can do the step alone.
- `fix.path` is a real, ready-to-call path with the ids filled in. It never holds a key or a token.
- `retry_after` (seconds) always comes with the `Retry-After` header.
- A `fix` that needs the user (delete, sign in, GitHub permission) says so: `"needs_user": true` plus a
  `user_url`. This matches product rule 2: the user decides, the agent does the rest.
- `docs` points to the skill section for that code, so a skill-less agent can still learn.

**ASK: the envelope.** Option A is to keep our `{ error, message, fix }` and add fields (no break, small
diff). Option B is to switch to full RFC 9457 (`type`/`title`/`detail`, `application/problem+json`),
which is a standard but breaks every client that reads `error`. Option C is both: add `type`/`title`
next to `error`/`message`. Recommendation: **A**. Agents and our own CLI and skill read `error` today,
and RFC 9457 adds nothing that an agent uses.

**Steps**
1. Add `lib/api-errors.ts` with one builder for each common error: `phoneNotReady(stored)`,
   `notFound("phone")`, `unauthorized(reason)`, `runnerUpdate(id)`, `busy()`, `timeout(s)`. It builds on
   `apiError` in `lib/http.ts`.
2. Replace the 11 copied `phone_not_ready` blocks. The `fix` depends on the state:
   - `stopped` → `POST /start`, then `wait_for=ready`.
   - `starting` / Android booting → only `wait_for=ready`, plus `retry_after`.
   - `deleted` → no fix, and the message says to create a phone.
3. `unauthorized` gets a reason: `missing_key`, `bad_key`, `revoked_key` or `expired_session`. The fix is
   "Run `emuly login`" or the device-login route (`POST /v1/agent/device`). Never say whether a key
   exists for another user.
4. `not_found` (phone) gets `fix: GET /v1/phones`.
5. `runner_update_required` gets `fix: POST /v1/phones/{id}/apps/update` with
   `repeat_until: {"status":"ready"}` (H3).
6. The generic `request_failed` 502 gets `retry_after` and a "retry once, then tell the user and give the
   issue link" line. Today an agent can't tell retrying from giving up.
7. `forbidden` (cross origin) and `setup-code` with an agent key (H7) get their own fixes.
8. Add a test that checks every error from `phone-agent-api.ts`: it has a code from the fixed list in
   `api-usage.ts`, and a `fix.path` (if any) matches a route in `V1_ROUTES`. This stops new errors
   without help.
9. CLI (`bin/emuly.mjs`): print `fix` on stderr as one line ("Next: POST …"). Keep stdout JSON only.
10. Skill: add a short "every error has `fix`; follow it" rule to `SKILL.md` and update
    `references/delete-and-errors.md`. Raise `AGENT_RUNBOOK_VERSION`.

**Edge cases**
- An error inside a proxied runner response (`phone-agent-api.ts:331, 404`): add a `fix` only for codes we
  know, and pass the others through unchanged.
- `fix.then` must not loop. A fix that points back to the same failing route gets `retry_after` and a
  limit (`max_retries: 3`).
- Self-host vs hosted: paths are relative (`/v1/...`) so they work on any base URL. `docs` uses `baseUrl()`.
- Old agents ignore the new fields. Nothing breaks.
- Size: `fix` adds about 150 bytes to an error reply. Nothing is added to success replies in this phase.

## Phase 2: hints on success when the agent works the slow way (high impact, medium effort)

**Format**: an optional `hints` list on any JSON reply.

```json
"hints": [{ "code": "use_wait_for", "message": "You polled this phone 4 times in 20 s. One call waits for you.",
            "try": { "method": "GET", "path": "/v1/phones/p-1?wait_for=ready&timeout_s=60" } }]
```

Rules (from the old plan, plus new ones):
- A hint never changes the status or the error code.
- The same hint code is sent at most once per caller per 10 minutes, so agents aren't spammed.
- No hints on binary replies (PNG, MP4, chunk uploads). For screenshots, use a response header
  `Emuly-Hint: use_ui_tree` instead, because the body is an image.
- Each hint we send is counted, so we can see if agents change.
- An agent can turn hints off with `X-Emuly-Hints: off` (some tools pay per token).

**Cases** (the first 4 use the existing detector in `lib/diagnostics/api-usage.ts`):

| Code | When | Try |
|---|---|---|
| `use_wait_for` | 3+ `GET /v1/phones/{id}` in 30 s while starting, or `poll_after_wait` | `?wait_for=ready` |
| `use_ui_tree` | `screenshot_burst` (today: more than 10 in 60 s; lower it to 3 in a row without input) | `GET /ui` |
| `stop_retrying` | `retry_same_route` 3 times | the `fix` from the first error |
| `update_skill` | `old_client` on any route | the skill update command (Phase 3) |
| `join_adb` | 5+ `POST /adb` in 10 s on one phone | one shell call joined with `&&` (or batch in Phase 5) |
| `use_cli` | curl client, on lists and errors only (H1) | install the CLI |
| `use_upload_ticket` | an inline upload close to the limit | the ticket route |

**Steps**
1. Change the detector so it *returns* the patterns it finds to the route (today it only counts them).
   Keep it in memory and keep the caller key hashed and never stored.
2. Add `lib/agent-hints.ts`: it maps a pattern to a hint and does the once-per-10-min rule.
3. Attach hints in the shared reply wrapper used by `app/v1/**` routes (the one that already calls api-usage).
4. Skill: add one rule, "If a reply has `hints`, follow the first one for the rest of this task. Don't tell
   the user." Raise `AGENT_RUNBOOK_VERSION`.
5. CLI: print hints on stderr once per run.

**Edge cases**
- **Vercel runs many instances.** An in-memory window only sees the calls that hit one instance, so some
  hints are missed. That's fine: a missed hint costs nothing, and a wrong hint is worse. Don't move this
  to Turso, because it would add a database trip to every call (product rule 4).
- Several agents on one key: the caller key is key + phone, so one agent's polling doesn't hint another's.
- Polling is sometimes right (a user is watching a phone boot in a script). The hint is advice only.
- The browser (session auth) gets no hints.

## Phase 3: skill updates with no guessing (high impact, low effort)

**Steps**
1. **Check the version on every `/v1` call, not just the list.** Use the `update_skill` hint from Phase 2,
   so a stale skill is noticed even when the agent never lists phones. Keep `skill_update` on
   `GET /v1/phones` as it is.
2. **No more placeholders.** The machine and agent files already know the OS and the agent. Have them send
   `X-Emuly-Skill-Install: <agent id>; <scope global|project>` next to `X-Emuly-Skill`, so the server
   returns one ready command, for example `npx skills add https://emuly.xyz -g -a claude-code -y`.
   - **ASK:** send the install info in a header on every call (simple, no storage) or store it per agent
     key at install (no extra header, but a new column). Recommendation: the header. It needs no schema
     change and no state.
   - The agent id is checked against a fixed list. Unknown values get the placeholder text as today.
3. **One-file download for agents without Node.** Add `GET /.well-known/skills/emuly-playbook.tar.gz` (or
   one JSON with all files) and its SHA-256. One request instead of about 25.
4. **`emuly skill update`** in the CLI: it finds the installed skill folder (it already reads the skill's
   base file, `bin/emuly.mjs:263`), downloads the bundle, checks the hash and swaps the folder.
   The CLI already updates itself, so this follows the same path.
5. **Say what changed.** Add `changes: "<one line>"` to `skill_update`, read from a short
   `content/skills/emuly-playbook/CHANGES.md`.
6. **Retry rule:** keep "once per chat", but allow one more try if the first failed because of the network.

**Edge cases**
- A skill installed by copy (not `npx skills`): the "same way you installed it" rule stays, and step 4 helps.
- Project-scope installs: the command must use `-p`, not `-g`. The header from step 2 carries the scope.
- Skill text on self-host differs (`{{EMULY_BASE_URL}}`). The hash is taken before the tokens are
  replaced (`lib/agent-runbook.ts:37`), so it's fine.
- Security: the bundle is served from our own origin over HTTPS. It holds no secrets. The CLI checks the hash.
  We never run code from the skill.

## Phase 4: the phone view and the "own window" (high impact, medium effort)

**Steps, in order**
1. **Stop pushing the scrcpy window.** Remove the 45 s popup (`phone-screen.tsx:248-280`). Show a small
   hint only when the page's video is actually struggling: the connection went to `fallback`, entered saver
   mode, or reconnected 3+ times in 2 min. The page already reports these.
2. **Pop-out in the browser** with Document Picture-in-Picture: move the canvas and controls into a small
   always-on-top window. No install, no terminal, no tunnel.
   - Fallback (Safari, Firefox < 151): open `/app/phones/<id>?view=window` in a sized `window.open` popup.
   - Mobile: hide the button.
   - Edge cases: input and keyboard events must work inside the PiP document. Copy the stylesheets.
     When the PiP window closes, move the canvas back. Only one video connection at a time.
3. **Make the page video better** (so the window is rarely needed): measure first (the `direct_path`
   diagnostics from `e6b4197`). Then tune the keyframe interval and quality steps, and follow
   `docs/global-streaming-plan.md`.
4. **The scrcpy script, for people who still want it:**
   - Show "first run: about 1 to 2 minutes" and a "what this does" link next to the command.
   - **ASK:** keep `-ExecutionPolicy Bypass` (works everywhere) or use `-Scope Process` (a little
     safer-looking, same effect for this one run). Recommendation: `-Scope Process`.
   - When the window opens, tell the runner. The page then pauses its own video and shows "Open in your
     window", which saves bandwidth (both stream today).
   - Wayland: skip placement quietly (it already does) and print nothing scary.
5. **For agents:** add `GET /v1/phones/{id}` → `viewers: { browser: n, window: n }`, so an agent knows
   whether the user is watching before it takes over the screen.

## Phase 5: bigger items (each one needs a design talk first)

- **Batch endpoint** `POST /v1/phones/{id}/batch`: a list of steps (`tap`, `type`, `adb`, `ui`,
  `wait_ms`, `screenshot`) run in order in one trip to the codespace. It returns one result per step and
  stops at the first error. **ASK:** run the steps on Vercel (simple) or in the runner (one trip, much
  faster, but needs a runner version bump). Edge cases: a per-batch time limit under the Vercel function
  limit, at most about 50 steps, and every step is logged like a single call.
- **Desktop helper** (`emuly://open/<id>` link handler or a small signed app) so the window opens with
  one click. This is high effort and needs code signing.

---

## Order and measuring

| Phase | Effort | Measure after 2 days |
|---|---|---|
| 0 fixes | small | `old_client` counted, write failures ~0 |
| 1 `fix` on errors | medium | `retry_same_route` and `runner_update_required` down by half |
| 2 hints | medium | `screenshot_burst` and `poll_after_wait` down; `/ui` calls up |
| 3 skill | small | share of calls with a current skill hash goes up |
| 4 phone view | medium | fewer `screenshot_fallback`; PiP opens vs. scrcpy script fetches |
| 5 batch, helper | large | adb calls per task down |

Rules for every phase (from AGENTS.md): run `pnpm lint`, `pnpm test` and `pnpm build`. Raise
`AGENT_RUNBOOK_VERSION` when the skill changes. Raise `RUNNER_VERSION` when `phone/runner/` changes.
Never log keys, tokens or IPs in hints or diagnostics.

## Sources

- [RFC 9457: Problem Details for HTTP APIs](https://datatracker.ietf.org/doc/html/rfc9457)
- [Swagger: Problem Details (RFC 9457), doing API errors well](https://swagger.io/blog/problem-details-rfc9457-doing-api-errors-well)
- [Gravitee: writing effective API error responses](https://gravitee.io/corpus/gen-1057/api-writer/writing-effective-api-error-responses-and-standardized-problem-details-rfc-9457.html)
- [Chrome: Picture-in-Picture for any element](https://developer.chrome.com/docs/web-platform/document-picture-in-picture)
- [MDN: Document Picture-in-Picture API](https://developer.mozilla.org/docs/Web/API/Document_Picture-in-Picture_API)
- [Mozilla intent to ship Document PiP (Firefox 151)](https://groups.google.com/a/mozilla.org/g/dev-platform/c/ZYhF7VNXwQU)
- [vercel-labs/skills README](https://raw.githubusercontent.com/vercel-labs/skills/HEAD/README.md)
