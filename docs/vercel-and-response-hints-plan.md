# Plan: Vercel usage and agent response hints

Date: 27 Nov 2026. Project: `paws/emuly` (Hobby). Region: `bom1`.

This plan has two parts. Part 1 cuts Vercel usage (sections 1 to 5). Part 2 adds hints to agent API responses (section 6).

## 1. What we measured

Hobby Observability keeps only 12 hours. All numbers below are for 12 hours (26 Nov 10:41 pm to 27 Nov 10:41 am IST).

30-day totals (team usage page): Fluid Active CPU 2h 18m of 4h. Fast Origin Transfer 5.78 GB of 10 GB.
At this rate both limits break within the month. The other team (`arnab-mondals-projects`) is already paused for Fluid Active CPU until 21 Dec 2026.

### Active CPU by route (12 h, 4.6K invocations, P75 94 ms, memory 251 MB of 2.05 GB)

| Route | Calls | Active CPU | Source in code |
|---|---|---|---|
| `/app/events` | 191 | 43s | SSE, `lib/shared/event-stream.ts` reads Turso every 1.5 s |
| `/app/phones/[id]` | 771 | 37s | full RSC render on each `router.refresh()` and prefetch |
| `/app/phones/[id]/actions` | 109 | 26s | SSE, plus one `adb wm size` per stream |
| `/v1/phones/[id]/links` | 411 | 23s | `components/phone/phone-links.tsx` polls every 30 s (plus `/proxy`) |
| `/app/phones/[id]/timing` | 895 | 19s | `phoneTiming` "presence" POST every 30 s |
| `/app` | 504 | 19s | dashboard render, refresh and prefetch |
| `/app/phones/[id]/stream-ticket` | 301 | 14s | each video connect, every 280 s |
| `/app/phones/[id]/frames` | 136 | 11s | PNG fallback WebSocket |
| `/v1/phones/[id]/[...apps]` | 114 | 8s | APK chunks through Vercel |
| `/v1/phones/[id]/proxy` | 409 | 8s | polled with `/links` |
| `/app/settings/hours` | 113 | 4.4s | `<Link>` prefetch from the top bar |
| `/app/phones/[id]/stream` | 130 | 4.4s | video relay (cheap CPU, long memory) |
| `/app/phones/[id]/screen.png` | 70 | 4.2s | 48.6% errors |

### Transfer by route (12 h, 224 MB out, 187 MB in)

| Route | In | Out | Total |
|---|---|---|---|
| `/v1/phones/[id]/[...apps]` | 162 MB | 0 | 162 MB |
| `/app/phones/[id]/stream` | 4 MB | 139 MB | 144 MB |
| `/app/phones/[id]/frames` | 0.3 MB | 43 MB | 43 MB |
| `/app/phones/[id]/screen.png` | 0.1 MB | 9 MB | 9 MB |
| `/app/phones/[id]` | 2.4 MB | 3.8 MB | 6 MB |
| `/v1/phones/[id]/recording/[action]` | 0 | 6 MB | 6 MB |

Four routes move 87% of the bytes. All four carry phone bytes (APK, video, PNG) through Vercel.

## 2. Root causes

1. **Phone bytes go through Vercel.** The direct path (port 8791 on the codespace) exists for video and CLI installs. The browser APK upload in `components/phone/phone-apps.tsx` always uses the Vercel chunk route. The video falls back to the Vercel relay when direct is "slow" or "blocked", and then stays on Vercel for 60 s or 10 min (`DIRECT_RETRY_MS`).
2. **Open tabs poll the server.** One visible phone tab makes these calls each minute: 40 Turso reads from `/app/events`, 40 from `/actions`, 2 `/timing`, 2 `/links`, 2 `/proxy`. Each SSE stream ends at 270 s and starts a new function with a new session check.
3. **Every change re-renders the whole page.** An SSE message calls `router.refresh()`. The server renders the full phone page and calls `syncPhoneStateLater`.
4. **Prefetch renders dynamic pages.** Top bar links prefetch `/app`, `/app/settings/hours` and phone pages in production. Each prefetch is a function call.
5. **Functions get 2 GB memory but use 251 MB.** Provisioned memory is billed for the full life of each SSE and WebSocket function (up to 300 s).

## 3. The plan

Order: biggest saving first, then lowest risk. Each step lists the expected saving on the 12-hour sample.

### Phase A: move phone bytes off Vercel (Fast Origin Transfer -80%)

A1. **Browser APK upload goes direct.** Reuse the `/v1/phones/[id]/adb/upload` ticket that the CLI uses. The browser PUTs the file to the codespace URL. Keep the chunk route only as fallback when the PUT fails. The runner needs CORS for the app origin on that one path. Saves about 162 MB / 12 h.
   Files: `components/phone/phone-apps.tsx`, `lib/phone/phone-agent-api.ts`, `phone/runner/` (CORS, then raise `RUNNER_VERSION`).

A2. **Make the direct video path hold.** Log why direct fails (`direct-result` already records "slow" and "blocked"). Read those rows first to see which one is common. Then:
   - "slow": retry direct sooner, and do not mark slow on one bad start.
   - "blocked": the network blocks `app.github.dev`. Keep relay, but use "saver" quality.
   Saves part of 144 MB.

A3. **PNG fallback goes direct.** `frames` and `screen.png` can use the same signed direct ticket as video. Fix the 48.6% error rate on `screen.png` first, because each failure is a wasted call. Saves about 50 MB.

A4. **Relay caps.** When video must use the relay, start at "saver" quality and stop it after 2 min with the tab not focused.

### Phase B: cut polling (Active CPU -40%)

B1. **One SSE per tab, not two.** Join `/app/phones/[id]/actions` into `/app/events`. Send agent actions in the same message. Cache `wm size` in the phones row, not per stream. Saves about 26s.

B2. **Slower SSE read, longer stream.** Read `user_changes.version` every 3 s, not 1.5 s. Raise the stream life from 270 s to 295 s (`maxDuration` is 300). Fewer restarts mean fewer session checks. Cuts `/app/events` CPU by about half.

B3. **Close SSE when idle.** Close the stream after 5 min with no input on a visible tab. Open it again on mouse, key or focus.

B4. **Drop the presence ping.** Send `presence` with the `stream-ticket` renew, not every 30 s on its own. Or send one batch with `navigator.sendBeacon` at page hide. Saves most of 895 calls and 19s.

B5. **Links and proxy: push, not poll.** The runner already pushes events (`/api/runner/events`). Bump `user_changes.version` when links change, so SSE tells the page. Remove the 30 s poll. Saves 820 calls and about 31s.

### Phase C: cheaper renders (Active CPU -20%)

C1. **Refresh only what changed.** The SSE message already holds `phones`. Update the client state from it, and call `router.refresh()` only when the phone state field changes. Cuts many of the 771 `/app/phones/[id]` renders.

C2. **No prefetch on dynamic links.** Set `prefetch={false}` on the top bar and user menu links to `/app`, `/app/settings/hours` and phone pages. Saves most of 113 hours renders and part of `/app`.

C3. **Static settings shell.** `/app/settings/hours` can render a static shell and load the data on the client.

### Phase D: function settings (Provisioned Memory -50%)

D1. Set function memory to 1 GB (Project Settings, Functions). The P75 use is 251 MB. Check the build and APK chunk routes for peak memory first.

D2. Keep `bom1`. Users and Turso are both in India, so the region is right.

## 4. Order of work and expected result

| Step | Effort | Saving |
|---|---|---|
| A1 direct APK upload | medium (runner change) | ~40% of transfer |
| B4 presence ping, B5 links push | small | ~1,700 calls, ~50s CPU / 12 h |
| C2 no prefetch | very small | ~150 renders / 12 h |
| B1 + B2 SSE | medium | ~50s CPU / 12 h |
| A2 + A3 direct video and PNG | medium, needs data first | ~40% of transfer |
| C1 partial refresh | medium | ~20s CPU / 12 h |
| D1 memory 1 GB | settings only | half of Provisioned Memory |

Target after all steps: Active CPU about 1h 15m / 30 days (from about 4h). Fast Origin Transfer about 1.5 GB / 30 days (from about 6 GB).

## 5. How to measure

- Before each step, save the 12-hour Functions and Fast Data Transfer tables from Observability.
- After deploy, wait 12 hours and compare the same tables.
- Add a test or a count for each poll that we remove, so it does not come back.

## 6. Part 2: agent response hints

Data: `diagnostic_api` on Turso, 25 to 26 Nov 2026. These counts are low, because `diagnostic_health` shows 3633 `writeFailures`.

### 6.1 What we measured

| Client (agent key) | Calls | Errors |
|---|---|---|
| curl | 837 | 1 |
| browser | 426 | 10 |
| other | 357 | 94 |
| cli | 355 | 6 |
| skill | 14 | 0 |

| Error code | Calls | Main route |
|---|---|---|
| `authorization_pending` | 451 | `POST /v1/agent/device/token` (455 of 459 fail) |
| `runner_update_required` | 435 | adb, screenshot, apps, links |
| `phone_not_ready` | 69 | screenshot (50), apps, proxy |
| `unauthorized` | 26 | screenshot from browser |
| `direct_upload_unavailable` | 7 | `POST /v1/phones/{id}/adb/upload` (cli 5, browser 2) |

Patterns: 30 `retry_same_route`, 4 `screenshot_burst`.
`POST /v1/agent/setup-code` failed 26 of 26 times. Agent keys get 403 from `forbidAgent`, so this is expected. The hint in H7 covers it.

### 6.2 Rules for every hint

- A hint is one short field. It never changes the status code or the error code.
- Use a structured `fix` object when the agent can act alone: `{ "method", "path", "repeat_until"? }`. Agents follow a field more reliably than a sentence.
- Never add a hint to upload chunk responses (`PUT .../content`). That is machine traffic.
- Count each hint we send in `diagnostic_api_patterns`, so we can see if it works.

### 6.3 The steps

H1. **CLI hint for curl and other clients.** `clientOf` in `lib/diagnostics/api-usage.ts` already finds the client.
   - Add `cli_hint` to every `GET /v1/phones` and `GET /v1/phones/{id}` response. Agents call these at the start of each task, so a new chat sees it. The cost is small (about 100 calls).
   - Add `cli_hint` to every 4xx and 5xx response.
   - Add `cli_hint` to 1 of every 20 `adb` and screenshot responses.
   - Send no hint when the request has `X-Emuly-Client: cli/...`.
   - Text: how to install the CLI, and that it retries, uploads direct and falls back alone.
   Files: a new `lib/agent-hints.ts`, `lib/phone/phone-agent-api.ts`.

H2. **Device token polling.** In `app/v1/agent/device/token/route.ts`:
   - Return `interval: 5` and `expires_in` (RFC 8628).
   - Return `slow_down` when a client polls faster than the interval.
   - Message: "Tell the user to open the link. Poll every 5 s."
   - Count `authorization_pending` as a normal result, not as an error, in the diagnostics.

H3. **Runner update.** In `runnerUpdateMessage` (`lib/phone/phone-response.ts`), add a `fix` object for `POST /v1/phones/{id}/apps/update` with `repeat_until: {"status":"ready"}`.
   - Add `runner_outdated: true` to `GET /v1/phones/{id}`, so the agent updates before an error.
   - Later: start the runner update at boot, so the error does not happen.

H4. **Phone not ready.** Add `state`, `retry_after` (seconds) and a `fix`: `POST /start` when stopped, wait when booting. Send a `Retry-After` header too. This targets the 30 `retry_same_route` hits.

H5. **Direct upload unavailable.** Add a `fix` for the app-installs chunk flow, with the exact routes. Make the CLI (`bin/emuly.mjs`) fall back to that flow alone.

H6. **Unauthorized.** Add: "Run `emuly login`, or send `Authorization: Bearer <key>`." Check why the browser gets 26 `unauthorized` on screenshot. The session may end too early.

H7. **Setup code from an agent key.** The 403 message must tell the agent to use the device sign-in (`POST /v1/agent/device`) instead.

H8. **Screenshot burst.** When the `screenshot_burst` pattern fires, add a hint to use `GET /v1/phones/{id}/ui`. The UI tree is smaller and faster.

H9. **Fix diagnostic write failures first.** 3633 lost writes make all counts too low. Fix them before we measure H1 to H8.

### 6.4 Order of work

| Step | Effort | Expected result |
|---|---|---|
| H9 write failures | small to medium | trusted counts |
| H2 token polling | small | ~400 fewer calls / 2 days |
| H3 runner fix object | small | fewer of 435 errors |
| H1 CLI hint | medium | more CLI calls, fewer curl errors |
| H4, H5, H6, H7 | small each | clearer next step on each error |
| H8 screenshot burst | small | fewer screenshots |

H2 also helps Part 1: fewer token polls means less Active CPU.

### 6.5 How to measure

- Before: save `diagnostic_api` grouped by client and error code for 2 days.
- After deploy: compare the same query after 2 days.
- Goal: the cli share goes up from 355 of 1989 agent-key calls. `authorization_pending` and `runner_update_required` go down by half.
- Skill: when the hint text changes `content/skills/`, raise `AGENT_RUNBOOK_VERSION` in `lib/agent-runbook.ts`.
