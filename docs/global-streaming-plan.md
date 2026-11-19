# Plan: fast phones in every region

Status: plan only. No code has changed. Written 2026-11-19.

## Goal

A user anywhere gets the same experience that a user in India gets today:

- The phone starts fast.
- Touch and video feel instant.
- The stream stays secure.
- The same is true for **coding agents** that use the phone through the `emuly` CLI and the `/v1` API, not only for people in the browser.

## What we measured and found

### 1. Every phone is created in India

- `CreateCodespace` in `lib/github/github.ts:64` sends no `geo` and no `client_ip`.
- GitHub then picks the region from the IP of the caller.
- The caller is the Vercel function in `bom1` (Mumbai), so every user gets a codespace in `CentralIndia`.
- The GitHub REST API has a `client_ip` field for this case: "IP for location auto-detection when proxying a request."
- Source: <https://docs.github.com/en/rest/codespaces/codespaces?apiVersion=2022-11-28>

### 2. The prebuild exists in only 2 regions

Checked with `GET /repos/codewarnab/emuly/codespaces/machines?location=<region>&ref=main&devcontainer_path=.devcontainer/phone/devcontainer.json`, `standardLinux32gb`:

| Region | Prebuild |
|---|---|
| CentralIndia | ready |
| SouthEastAsia | ready |
| EastUs | none |
| WestUs2 | none |
| WestEurope | none |

Without a prebuild, `phone/scripts/prebuild.sh` runs at create time: Android SDK, system image, AVD. So a new phone in the US or Europe boots much slower.

**Risk:** if we fix item 1 before this, US and Europe users get slower first boots. So prebuilds must come first.

### 3. Every frame goes through Mumbai

- Path today: browser → Vercel (`bom1`) → `*-8790.app.github.dev` → runner.
- Measured from India, 50 pings each, phone in `CentralIndia`:

| Path | Median | p95 | Slowest |
|---|---|---|---|
| Direct | 77–84 ms | 98–102 ms | 104–107 ms |
| Through Vercel | 77–79 ms | 99–112 ms | 123–144 ms |

- For India the gain is small. For a US user with a US codespace, each frame and touch would travel US → Mumbai → US. Estimate: 200–280 ms extra. Not measured yet (Phase 0 measures it).

### 4. The first stream connection took 18.3 seconds

- The first `stream-ticket` call took 18,308 ms. The second took 200 ms.
- First video came after 19,224 ms. With a warm server it came after 508 ms.
- Probable cause: the first link from the server to the codespace (port probe, then maybe the tunnel fallback in `lib/github/codespace-tunnel.ts`). Not proven yet.

### 5. Agents take the same detour, many times per task

An agent works in a loop: screenshot → tap → screenshot. Each step is one round trip. Every `/v1` call goes agent → Vercel (`bom1`) → codespace → back.

| Agent feature | Route today | Problem outside India |
|---|---|---|
| Taps, screenshots, UI tree (agent-device) | `/v1/phones/[id]/agent-device-proxy/...` | Each step pays the detour. 50 steps × 250 ms = 12.5 s extra per task |
| adb commands | `/v1/phones/[id]/adb` | Same |
| APK install | `/v1/phones/[id]/[...apps]` | Large uploads cross the world twice, and pass Vercel body limits |
| Screen recording | `/v1/phones/[id]/recording/[action]` | Large downloads cross twice |
| Links to laptop servers | `/v1/phones/[id]/links/relay` (WebSocket) | Every request the phone app makes to the laptop pays the detour; `maxDuration = 300` cuts it every 5 minutes |
| App events | `/v1/phones/[id]/app-events` | `maxDuration = 300` cuts it every 5 minutes |

The agent runs on the user's laptop, so it is near the user, and after Phase 2 also near the phone. Only Vercel is far away.

### 6. The runner has no secret

- `phone/runner/runner.mjs:30` reads `PHONE_SECRET`. On both test phones it was empty.
- With an empty secret the runner skips every auth check, including `adb` passthrough.
- This is safe today only because port 8790 is private. It blocks any public port.

## Phase 0 results (2026-11-19)

Test setup: throwaway codespaces from `github/codespaces-blank` (`basicLinux32gb`) in EastUs and WestEurope, plus the CentralIndia phone `phone-gentle-wombat`. Each ran `scripts/spike/echo-server.mjs` on a public port 8791 and acted as a client too. Scripts are in `scripts/spike/`. All test codespaces were deleted afterwards.

### 0.1 Region choice: `client_ip` does not work, `geo` does

| Request | Result |
|---|---|
| `client_ip` = 54.85.0.10 (AWS us-east-1) | `CentralIndia` |
| `client_ip` = 18.194.0.10 (AWS eu-central-1) | `CentralIndia` |
| `geo` = `UsEast` | `EastUs` |
| `geo` = `EuropeWest` | `WestEurope` |

GitHub ignored `client_ip` for our OAuth user token. So Emuly must pick the `geo` itself. Vercel already sends the user's location in each request (`x-vercel-ip-country`, `x-vercel-ip-latitude`, `x-vercel-ip-longitude`). Map it to the nearest of `UsEast`, `UsWest`, `EuropeWest`, `SoutheastAsia`. For India and nearby countries, send no `geo`: GitHub then uses the Vercel IP in Mumbai, which gives `CentralIndia`.

Also: one account can run only **2 codespaces at a time** ("You have too many codespaces running").

### 0.2 Public port: works

- `gh codespace ports visibility 8791:public` works only after the port is registered on the tunnel. Before that it returns 404. A phone must list 8791 in `forwardPorts` in `.devcontainer/phone/devcontainer.json`.
- After that, `https://<codespace>-8791.app.github.dev/health` answered 200 with no GitHub sign-in.
- Port 8791 turned public while the other ports stayed private.
- Not done yet: the same call from Node through the Dev Tunnels API (Phase 4 step 1).

### 0.3 Browser WebSocket to a public port: works, with two notes

- Headless Chrome on a page at `https://emuly.vercel.app/` opened `wss://<codespace>-8791.app.github.dev/` with no sign-in and no warning page. The server saw `Origin: https://emuly.vercel.app`, so the runner can check the origin.
- **Note 1:** a normal page visit (`Accept: text/html`) to a public port gets a GitHub warning page, "Codespaces Access Port". So the direct path must use WebSocket or `fetch` from code, never a page visit or an `<img src>`.
- **Note 2:** the DNS server on our office network refuses `*.app.github.dev` ("Query refused"), so the in-app browser could not open the port at all. Other users will be on networks like this. **The Vercel fallback is required, not optional.**

### 0.4 Real latency by region

WebSocket ping round trips, 40 pings each, median (p95):

| Client \ Server | US East port | West Europe port |
|---|---|---|
| US East client | 7 ms (12) | 99 ms (118) |
| West Europe client | 96 ms (108) | 9 ms (26) |
| Central India client | 200 ms (208) | 134 ms (159) |

Vercel function round trip (`/v1/phones`, kept-alive connection, 30 calls), median (p95):

| Client | Route | Median |
|---|---|---|
| US East | `iad1::bom1` | 240 ms (265) |
| West Europe | `fra1::bom1` | 163 ms (199) |

What a user feels on the stream (network only, estimated from the tables above):

| User | Today: India phone via Vercel | Region fix only: local phone via Vercel | Region fix + direct path |
|---|---|---|---|
| US East | ~210 ms | **~440 ms** (worse) | ~7 ms + user's own line |
| West Europe | ~145 ms | **~300 ms** (worse) | ~9 ms + user's own line |
| India | ~80 ms (measured) | ~80 ms | ~80 ms |

**Key result:** moving the phone near the user *without* the direct path makes it worse, because every frame then goes to Mumbai and back. Phase 2 must not ship before Phase 4, or Phase 2 must be limited to agents and boots until then.

### 0.5 The 18-second first connection: probable cause, not proven

- The production logs keep no step timings, so I could not confirm the cause.
- In `lib/phone/phone-link.ts` the server first probes `https://<codespace>-8790.app.github.dev/health` with a 5-second limit. If that fails, it opens the dev-tunnel relay over SSH (`lib/github/codespace-tunnel.ts`: metadata fetch, relay connect, SSH with a 30-second limit).
- 18 s fits "probe fails at 5 s, then a cold tunnel setup takes about 13 s".
- Phase 5 adds a `Server-Timing` header to `stream-ticket` so the next cold start shows each step.

### 0.6 Agents: partly measured

- Each `/v1` call from the US costs about 240 ms in Vercel before it reaches the phone. An agent step with 2 calls (screenshot + tap) costs about 480 ms of network alone from the US today, against about 15 ms with a local phone on the direct path.
- Not measured yet: real agent-device steps and a 50 MB APK upload. That needs a phone with the runner in each region, which needs Phase 1 prebuilds first.

### Decision

The direct path passed Phase 0 (0.2 and 0.3). Continue with Phases 1, 3, and 4. Change the order so Phase 2 (region) ships **together with or after** Phase 4 (direct path).

## The plan

Six phases. Each phase ships on its own and has its own tests. The order removes risk first.

### Phase 0: Prove the unknowns (spike, 1–2 days)

No product code. Scripts only, in `scripts/spike/`.

| # | Question | How we test it | Pass |
|---|---|---|---|
| 0.1 | Does `client_ip` put the codespace near the user? | Create test codespaces with `client_ip` set to a known US, EU, and SG address. Read `location`. | Each lands in the matching region |
| 0.2 | Can the server make one port public? | Use the Dev Tunnels API with `managePortsAccessToken` from `GET /user/codespaces/{name}?internal=true&refresh=true`, the same way `gh codespace ports visibility` does. | Port 8791 turns public; 8790 stays private |
| 0.3 | Can a browser open a WebSocket to a public port from `emuly.vercel.app`? | Plain `new WebSocket("wss://<cs>-8791.app.github.dev/stream")` from the in-app browser. | Socket opens. No login page, no warning page |
| 0.4 | What is the real gain outside India? | Run the ping script from client codespaces in `UsEast`, `UsWest`, `EuropeWest`, `SoutheastAsia`, against a phone in the same region, on both paths. | A table of real numbers |
| 0.5 | Why did the first ticket take 18 s? | Read the server timing logs (`measure(...)` marks) for a cold connection. | A named cause |
| 0.6 | What does the detour cost an agent? | From each client region, time 20 agent-device steps (screenshot + tap) and one 50 MB APK upload, through Vercel and direct. | A table of real numbers |

Decision gate: if 0.2 or 0.3 fails, we drop the direct path. Then we use Phase 5B (Vercel in more regions) instead.

### Phase 1: Prebuilds in every region (owner task, half a day)

1. In `codewarnab/emuly` → Settings → Codespaces → the prebuild for `.devcontainer/phone/devcontainer.json`, add the regions: EastUs, WestUs2, WestEurope (CentralIndia and SouthEastAsia exist).
2. Wait until each region shows `ready` with the machines API call above.
3. Add `scripts/check-prebuilds.mjs`. It calls that API for every region and fails if one is not `ready`. Run it in CI each day.

Cost: prebuild storage is billed to the repository owner, once per region. Check the size on the prebuild page before you add regions. GitHub can also keep fewer prebuild versions to save storage.

Test:
- Create one phone in each region (with `geo`). Measure "create" → "Android ready". Each must be within 20% of CentralIndia.

### Phase 2: Create phones near the user (1 day)

1. In the create action, read the user's location from the Vercel headers `x-vercel-ip-latitude` and `x-vercel-ip-longitude` (Phase 0.1 showed that `client_ip` is ignored).
2. Pick the nearest `geo`: `UsEast`, `UsWest`, `EuropeWest`, or `SoutheastAsia`. For India and nearby countries, send no `geo`. Add `geo?: string` to `CreateCodespace`. Agents that create a phone through `/v1` get the same rule from the agent's request.
3. Store the region (`location` from the response) on the phone row. Show it on the phone page: "Region: US East".
4. Add a setting: "Phone region: Automatic / US East / US West / Europe West / Southeast Asia". "Automatic" sends `client_ip`. The others send `geo`.
5. Phones that exist now stay where they are. A phone page shows a hint when the phone region is far from the user, with a link to make a new phone.

Privacy: the location is used once to pick the region and is not stored. Only the region name is stored.

Tests:
- Unit: the location-to-`geo` map. New York → `UsEast`, San Francisco → `UsWest`, Berlin → `EuropeWest`, Singapore and Sydney → `SoutheastAsia`, Mumbai → none. Missing headers → none.
- Unit: a user setting other than Automatic overrides the headers.
- Live: create one phone through the real Emuly flow with each setting and read `location`.

### Phase 3: Secure the runner (2 days, required before Phase 4)

1. **A secret on every phone.** Emuly makes a random 32-byte secret for each phone and stores it encrypted. The runner gets it through the existing private boot path, never through a public port. The runner writes it to a file with mode `0600`.
2. **Fail closed.** If the secret is empty, the runner refuses to start the public listener.
3. **A separate public port.** A new listener on port 8791 serves **only** `GET /stream` as a WebSocket. Every other path returns 404. Port 8790 (adb, files, apps, links) stays private.
4. **Signed tickets.** A ticket holds `phoneId`, `userId`, `sessionId`, `quality`, an expiry of 30 seconds, and a random nonce. Emuly signs it with HMAC-SHA256 and a key derived from the phone secret.
5. The runner checks, in order: signature (constant-time compare), expiry, `phoneId`, nonce not used before, and `Origin` header equal to the Emuly origin. Any failure closes the socket with no detail.
6. **Revocation.** Logout, phone stop, and phone delete call a private runner route that closes all direct sockets for that user or phone.
7. **Limits.** At most 8 direct viewers per phone, and at most 20 upgrade tries per minute per IP. Input keeps the existing 240 messages per second limit.

Tests (all must pass before Phase 4):
- Unit: valid ticket passes. Expired, wrong phone, bad signature, changed field, reused nonce, and wrong `Origin` all fail.
- Runner integration: with an empty secret, port 8791 doesn't listen.
- Runner integration: every path except `/stream` on 8791 returns 404, including `/adb`, `/health`, and `/links/relay`.
- Runner integration: after a revoke call, the open socket closes within 1 second.
- Security test against a live public port: no ticket, an old ticket, another user's ticket, and a replayed ticket. All fail. Results go into the pull request.

### Phase 4: Direct stream with fallback (2–3 days)

1. After Android is ready, the server makes port 8791 public with the Dev Tunnels API (Phase 0.2). It first checks `runtime_constraints.allowed_port_privacy_settings`. If `public` is not allowed, the phone stays on the Vercel path.
2. `stream-ticket` returns two things: the signed direct ticket with the direct URL, and the current Vercel ticket.
3. The browser tries the direct URL first, with a 3-second limit to open. If it fails, it uses the Vercel path at once. It remembers the result per phone for the browser session.
4. Presence pings every 30 seconds still go to Emuly, so Emuly still knows who watches.
5. The direct socket has no 280-second limit. So the reconnect every 280 seconds stops.
6. A feature flag `EMULY_DIRECT_STREAM` (off, team only, all). It starts off.

Tests:
- Unit (`phone-video-connection.test.ts`): direct opens → uses direct. Direct fails or times out → falls back within 3.5 s. Direct closes mid-stream → reconnects, then falls back if needed.
- End-to-end in the in-app browser: video plays, touch works, quality switch works, audio works, and recording still works.
- Fallback test: set port 8791 private by hand. The stream must still play through Vercel.
- Soak test: 30 minutes on the direct path with no freeze. Today's path cuts every 280 s.

### Phase 4B: Direct path for agents (3 days)

Agents need more than video, so they need a wider but still limited door.

1. **New route `POST /v1/phones/{id}/direct`.** The agent calls it with its normal Emuly agent token. Emuly checks the token, the phone owner, and that the phone runs. It returns:
   - the direct base URL: `https://<codespace>-8791.app.github.dev`
   - a **direct token**, signed like the browser ticket, but valid for 10 minutes and usable many times
   - the **scopes** the agent token allows, for example `agent-device`, `adb`, `apps`, `recording`, `links`
2. **The runner checks the scope on each request.** Port 8791 now also serves the agent routes, but each route needs a direct token with its scope. The existing agent-device policy and the adb argument checks stay in force.
3. **The CLI (`bin/emuly.mjs`) uses it on its own.** It asks for a direct token, uses the direct URL, and renews the token 1 minute before expiry. If the direct call fails, it repeats the call through Vercel once and stays on Vercel for that phone for 10 minutes. The agent sees no change in commands or output.
4. **Third-party agent tools.** `/v1/phones/[id]/agent-device` returns the direct proxy URL when the direct path works, so tools that use agent-device directly also skip Vercel.
5. **Keep the records.** Today Emuly logs agent actions as events and sends webhooks. On the direct path the runner sends each action record to Emuly in batches, every 2 seconds, through the private side. If Emuly is not reachable, the runner keeps up to 1,000 records and retries. No action may be lost from the log.
6. **Keep the phone awake.** The idle-stop timer must count direct agent activity. The runner reports "last activity" to Emuly with the action batches.
7. **Revoke.** When the user revokes an agent token, Emuly tells the runner on the private side. The runner rejects that token's direct tokens at once. Each direct token holds the agent token ID for this check.
8. **Long sockets.** `links/relay` and `app-events` on the direct path have no 300-second limit.

Tests:
- Unit: a direct token without the `adb` scope can't call `/adb`. Expired and revoked tokens fail. A token for phone A fails on phone B.
- Unit: the CLI renews before expiry, falls back to Vercel after one failed direct call, and output stays the same on both paths.
- Integration: run the existing CLI test suite twice, once forced direct, once forced through Vercel. Both must pass.
- Integration: 100 agent actions on the direct path produce exactly 100 events in Emuly, and the webhooks fire.
- Integration: an agent that works only on the direct path for 40 minutes keeps the phone running past the idle limit.
- Integration: revoke an agent token mid-task. The next direct call fails within 2 seconds.
- Live: Phase 0.6 again. Upload a 50 MB APK and record 2 minutes of video on the direct path.
- Live: a links relay stays open for 30 minutes with no cut.

### Phase 5: Faster first connection (1–2 days)

- **5A.** Fix the cause found in Phase 0.5. Likely steps: open the server's link to the codespace when Android becomes ready, not at the first viewer; and keep the result of the port probe.
- **5B (only if the direct path fails Phase 0).** Run the stream function in more Vercel regions (for example `iad1`, `fra1`, `sin1`) and route each phone to the region nearest its codespace. Check the Vercel plan limits first.

Test: cold first video under 3 seconds, measured 5 times in each region.

### Phase 6: Global test matrix in CI (1 day)

- A workflow that runs once a week and on demand:
  1. It starts one phone in each region.
  2. Client codespaces in each region run the ping script against both paths.
  3. It writes one table to the job summary: open time, first video, median, p95.
  4. It stops and deletes every test codespace at the end, even on failure.
- A run fails if any region has a median above 150 ms or a first video above 5 s.

## Success targets

| Value | Target in every region |
|---|---|
| Phone create to Android ready | within 20% of CentralIndia |
| First video, cold | under 3 s |
| Ping median | under 100 ms when the user and the phone are in the same region |
| Ping p95 | under 150 ms |
| Stream cuts | none in 30 minutes |
| Agent step (screenshot + tap) | under 2× the same step run inside the codespace |
| Agent actions lost from the event log | none |
| Agent CLI tests | all pass on both paths |
| Security tests | all pass |

## Order and time

| Phase | Depends on | Time |
|---|---|---|
| 0. Spike | none | 1–2 days |
| 1. Prebuilds | none (owner task) | half a day plus waiting |
| 2. Region near the user | Phases 1 and 4 (ship together with 4) | 1 day |
| 3. Secure runner | Phase 0 | 2 days |
| 4. Direct stream | Phase 3 | 2–3 days |
| 4B. Direct path for agents | Phase 3 | 3 days |
| 5. First connection | Phase 0.5 | 1–2 days |
| 6. CI matrix | Phases 2 and 4 | 1 day |

Phases 1 and 3 can run at the same time. Phases 4 and 4B can run at the same time after Phase 3.

Phase 6 also runs the agent loop (20 steps) from each region, on both paths.

## Open questions

1. Prebuild storage cost per region. Check the size on the prebuild settings page.
2. Why does GitHub ignore `client_ip`? It may work only for GitHub Apps. It doesn't matter now, because `geo` works.
3. The Dev Tunnels port API isn't a documented GitHub API. `gh` uses it, but GitHub can change it. The fallback to Vercel protects us if it breaks.
4. `geo` has no India value. Indian users must use "Automatic".

## Phase 3 results (2026-11-19)

Code: `phone/runner/direct-ticket.mjs`, `phone/runner/direct-server.mjs`, `lib/phone/direct-ticket.ts`, runner version 15.
Change from the plan: the phone key is HMAC(`EMULY_DIRECT_SECRET`, codespace name), not a stored random secret. No database change. The private SSH setup writes it to `~/emuly/.direct-key` (mode 0600).

Unit and integration tests: 19 new tests pass (`direct-ticket.test.ts`, `direct-server.test.ts`).

Live security test (`scripts/spike/direct-security.mjs`), test codespace in CentralIndia, port 8791 public:

| Case | Result |
|---|---|
| Valid ticket | opens |
| No ticket | 404 |
| Old ticket (31 s) | 404 |
| Ticket for another phone | 404 |
| Ticket signed with another secret | 404 |
| Replayed ticket (second use) | 404 |
| Wrong Origin | 404 |
| WebSocket `/adb`, `/links/relay` with a valid ticket | 404 |
| HTTP `/health`, `/screenshot` | 404 |
| 25 bad tries in 1 minute | 429 after 20 tries |

GitHub's port proxy replaces `X-Forwarded-For` and `X-Real-IP` with the real client IP. A client can't fake its address, so the per-IP limit is safe.

Still open: logout and phone delete must call `POST /direct/revoke`.

## Phase 4 results (2026-11-19)

Live test: test phone `phone-quiet-bison` (CentralIndia), runner 15, `EMULY_DIRECT_STREAM=all`.

| Check | Result |
|---|---|
| Key file | mode 0600; runner listens on 8791 only with a valid key |
| Ports | 8791 public, 8790 still private (302) |
| Direct video from Node | open 345 ms, first packet 1256 ms, RTT median 71 ms, p95 94 ms |
| Browser on a network that refuses `*.app.github.dev` DNS | direct fails fast, falls back to the server path at once, about 60 ms delay |

Not tested: direct video in a real browser (our network blocks the DNS name), audio, quality change.
The 30-minute soak run printed no result, so it gives no evidence.
Seen before this work too (flag off): `ECONNRESET` errors in local dev logs, and 6–16 s "Reconnecting" after Home or Recent apps on a static screen.

### Blocked DNS for `*.app.github.dev`

Some providers refuse this name in DNS (we saw "Query refused" from Reliance Jio; `github.com` resolves).
Indian ISPs also blocked Supabase domains in DNS in 2026. Nobody published the reason for this block.
- The browser calls a direct failure under 1.5 s "blocked" (no server answered). A slower failure is "slow" and shows nothing.
- It shows a notice with fixes (DNS 1.1.1.1 or 8.8.8.8, Secure DNS, another network) and source links.
- It reports once per tab to `POST /app/phones/[id]/direct-result`. Table `user_network` keeps it 3 days.
- `GET /v1/phones` then has `network_hint`. The skill tells the agent to relay it once, in simple words, with the sources.
Deploy note: run `npm run db:migrate` before this ships.
