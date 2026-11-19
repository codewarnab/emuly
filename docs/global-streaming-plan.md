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

1. In the create action, read the user's IP with the existing `clientIp()` from `lib/auth/agent.ts`. It already rejects spoofed `x-forwarded-for` values.
2. Send it as `client_ip` in the create request. Add `client_ip?: string` and `geo?: string` to `CreateCodespace`.
3. Store the region (`location` from the response) on the phone row. Show it on the phone page: "Region: US East".
4. Add a setting: "Phone region: Automatic / US East / US West / Europe West / Southeast Asia". "Automatic" sends `client_ip`. The others send `geo`.
5. Phones that exist now stay where they are. A phone page shows a hint when the phone region is far from the user, with a link to make a new phone.

Privacy: the IP goes only to GitHub, in the create call, and is not stored.

Tests:
- Unit: the create request contains `client_ip` when the setting is Automatic, and `geo` otherwise. A local or unknown IP sends neither.
- Unit: a spoofed `x-forwarded-for` doesn't reach `client_ip`.
- Live: Phase 0.1 again, through the real Emuly create flow.

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
| 2. Region near the user | Phase 1 | 1 day |
| 3. Secure runner | Phase 0 | 2 days |
| 4. Direct stream | Phase 3 | 2–3 days |
| 4B. Direct path for agents | Phase 3 | 3 days |
| 5. First connection | Phase 0.5 | 1–2 days |
| 6. CI matrix | Phases 2 and 4 | 1 day |

Phases 1 and 3 can run at the same time. Phases 4 and 4B can run at the same time after Phase 3.

Phase 6 also runs the agent loop (20 steps) from each region, on both paths.

## Open questions

1. Prebuild storage cost per region. Check the size on the prebuild settings page.
2. Does a user's own "default region" setting on GitHub override `client_ip`? The docs don't say. Phase 0.1 checks it.
3. The Dev Tunnels port API isn't a documented GitHub API. `gh` uses it, but GitHub can change it. The fallback to Vercel protects us if it breaks.
4. `geo` has no India value. Indian users must use "Automatic".
