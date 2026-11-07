# Live screen implementation report

Implemented through Phase 5. Prior local checks are recorded below. Real Codespace and browser acceptance checks remain pending.

## Pre-commit review — 2026-11-07

- Fixed incomplete wiring for the SSH `pty` option and the stream keep-awake callback.
- Stream keep-awake runs only while a stream lease exists. Releasing the last stream or closing the phone clears its timer.
- TypeScript (`tsc --noEmit --incremental false`), JavaScript syntax checks, and `git diff --check` passed.
- Tests and builds were not rerun during this review. The required disposable isolation environment was unavailable on this Windows host: Docker and WSL were unavailable. Earlier test results below are historical, not verification of these final fixes.
- Webhook and New phone loading states use skeletons. The original flat Activity log remains unchanged.

| Phase | Delivered |
| --- | --- |
| 0 | Server-only connection pool per owner and phone. Probes the private forwarded URL with `X-Github-Token`. Redirects, errors, and invalid health responses fall back to one persistent Dev Tunnel bridge to port 8790. Concurrent requests share connection setup. Connections close after two idle minutes, stopping, or deletion. Failed input is never replayed automatically. |
| 1 | Setup triggers `/boot` with `resume`. Android status, start time, and failures persist separately from Codespace status. Activity records Android starting and ready with elapsed seconds. The stage shows elapsed boot time and Retry boot. Reconciliation recovers interrupted boots. Stop waits for `/stop` before asking GitHub to stop. The runner serializes boot and stop. |
| 2 | Authenticated `screen.png` GET and POST routes check ownership. Visible tabs fetch PNG frames once per second without overlapping polls. Taps use the PNG's natural dimensions. Home, Back, and PNG download controls work through the server. Hidden tabs abort polling. Frames remain visible and dimmed after stopping. |
| 3 | Setup installs scrcpy-server 3.3.4 with a fixed SHA-256. Runner protocol 3 opens video and control sockets through ADB, encodes H.264 at max_size=1080 and max_fps=30, and frames packets with config/key flags, PTS, and send time. A custom Node server proxies `/app/phones/:id/stream` through the Phase 0 pool. Session-issued tickets expire after 60 seconds and bind user, phone, cookie, and origin. Tickets are single-use. Redemption rechecks the stored session, user block status, ownership, and Android readiness. GitHub credentials stay upstream. A failed private WebSocket handshake switches the next attempt to the persistent bridge. WebCodecs draws Annex B H.264 on a canvas. Hiding the tab closes the encoder connection; resume starts a new encoder and waits for its first keyframe. Reconnect delays are 1, 2, and 5 seconds. Screenshots remain the fallback. |
| 4 | The same socket carries bounded touch down/move/up/cancel, captured drags, multi-pointer IDs, and wheel scrolling. Focused keyboard handling sends text, navigation keys, and modified letter/digit shortcuts. Ctrl+V/Cmd+V uses the browser paste event and the Android clipboard protocol. IME composition sends committed text. Home, Back, Recent apps, Rotate, Volume up/down, and canvas PNG download are available. Blur releases held keys and touches. Runner cleanup also releases held input. Screenshot fallback retains Phase 2 tap/Home/Back support. |
| 5 | Rendered FPS and estimated transport-plus-decode delay appear below the screen. Auto starts at 1080/30, then selects Saver when delay exceeds 350 ms or the decoder queue exceeds five frames. Sharp uses 1080/30 at 8 Mbps; Saver uses 720/15 at 1.5 Mbps; Auto starts at 4 Mbps. Quality changes restart the encoder. The last canvas frame remains dimmed when stopped, with Resting. A placeholder fills the stage before any frame exists. |

## Verification

- `npm run lint`: passed.
- `node --conditions=react-server --test --test-isolation=none --experimental-strip-types lib/*.test.ts`: 95 passed, zero failures.
- `node --check` on the runner, scrcpy modules, proxy, and custom server, plus `git diff --check`: passed.
- Focused tests cover connection reuse, fallback, token refresh, owner separation, idle cleanup, cancellation, and no automatic mutation replay.
- Lifecycle tests cover automatic boot, explicit retry, late boot completion during stop, and refused shutdown after runner failure.
- Route tests cover authentication, ownership, readiness, origin, bounded input, PNG responses, and credential-safe errors.
- Tests use synthetic credentials, temporary databases, and a loopback HTTP server. No emulator or remote scripts run locally.

## Real codespace checks still needed

1. Confirm that GitHub accepts the owner's GitHub App token at the private forwarded-port URL.
2. Confirm the Dev Tunnel bridge reaches the loopback runner without SSH.
3. Measure first response time and warm `/health` latency. The Phase 0 target of under 300 ms is unproven.
4. Verify emulator boot, snapshot save/resume, PNG frame rate, tap alignment, and Home/Back in a browser.
5. Check the rendered stage on desktop and mobile, including tab hiding and last-frame retention.

## Open risks

- This design requires a long-running Node process. Connection pools and background boots do not fit short-lived serverless handlers.
- A boot can take several minutes. `/stop` waits behind boot in the runner. A stop timeout preserves the running Codespace and asks the user to retry.
- A failed runner stop prevents stopping a running phone, preserving the chance to save its snapshot. During setup, runner failure permits Codespace shutdown and logs that no snapshot was saved.
- When GitHub stops a Codespace outside phonelink, snapshot saving cannot be guaranteed.
- The forwarded-port and Dev Tunnel paths remain private. Do not expose runner port 8790 publicly; the browser receives neither GitHub tokens nor tunnel credentials.
- Setup recognizes runner protocol version 3 and refreshes older runners before boot. Existing installed phones require setup reconciliation or Retry setup before streaming.
- HTTP screenshot polling remains the fallback when video is unavailable. Smooth video and full input still require real Codespace and browser acceptance checks.

## WebSocket decision

Read the installed Next.js 16 route-handler guide, route API reference, custom-server guide, and backend-for-frontend deployment notes.
The documented route-handler interface exposes HTTP methods, not a raw socket upgrade.
The deployment notes warn that WebSockets fail on hosts whose handlers close after a response or timeout.
Phases 3-5 use `server.mjs`, a small custom Node server on the same port as Next.js. It delegates normal HTTP and HMR upgrades to Next.js and handles only the phone stream path.
Do not attempt an undocumented `Response(101)` route-handler upgrade.


## Running locally

1. Use Node 24.18 or newer, matching the checked local runtime. The custom server imports TypeScript ticket logic through Node type stripping.
2. Stop your existing development process yourself, then run `npm run dev`. This starts `node server.mjs` at `http://127.0.0.1:4321`.
3. `npm run build` followed by `npm start` uses the same custom server in production mode. `HOST` and `PORT` override the bind address and port.
4. Keep the runner on loopback port 8790. Setup transfers its JavaScript modules, the bundled WebSocket implementation, and license before starting it.
5. Direct `next dev` / `next start` still serves HTTP screenshots, but does not install the phone WebSocket upgrade handler. Do not use standalone/serverless output for this deployment.

The existing development process was left running. A second process initially refused Next's development lock.
A separate temporary Next.js app then verified that a compiled route can issue a ticket which the custom server redeems.
Its WebSocket reached a synthetic upstream and returned the expected message. The temporary app and process were removed afterward.
No real credentials, emulator binary, installer, or remote setup scripts ran in these checks.

## Additional local verification for Phases 3-5

- Protocol fixtures verify split/coalesced packets, key/config flags, PTS, Annex B SPS codec detection, input serialization, clipboard UTF-8, coordinates, and rejected input.
- Ticket tests verify user/phone/browser bindings, exact expiry, replay refusal, and issuance authorization/readiness checks.
- Phase 0 tests verify stream leases, cancellation, refreshed upstream credentials, and switching from a failed private WebSocket to the bridge.
- A loopback WebSocket integration test verifies video bytes, input JSON, credential isolation, quality forwarding, replay refusal, and lease cleanup.
- The user-required test command runs synthetic local logic and loopback services. It does not start ADB, scrcpy, or Android.

## Real Codespace and browser acceptance still required for Phases 3-5

1. Run setup on an existing phone. Check the downloaded digest, runner protocol 3, ADB forwarding, scrcpy launch, first config packet, and first keyframe.
2. Verify both private forwarded-port WebSockets and bridge fallback. Measure warm latency and click-to-display latency against the 300 ms target.
3. Exercise WebCodecs in Chromium over localhost/HTTPS. Check fallback without WebCodecs, hidden-tab shutdown, fresh resume, 1/2/5-second reconnects, and stalled-stream recovery.
4. Check drag/swipe, multi-touch, wheel scroll, key repeat, modified shortcuts, IME, Unicode paste, all buttons, PNG download, and rotation alignment.
5. Check Auto/Sharp/Saver dimensions and FPS, CPU under concurrent viewers, dimmed Resting retention, mobile layout, and behavior after a server/browser restart.

## Protocol references

- [scrcpy 3.3.4 release assets](https://github.com/Genymobile/scrcpy/releases/expanded_assets/v3.3.4) publish the pinned server digest: `8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e`.
- [scrcpy Streamer](https://github.com/Genymobile/scrcpy/blob/v3.3.4/server/src/main/java/com/genymobile/scrcpy/device/Streamer.java) defines video packet headers.
- [scrcpy control serialization](https://github.com/Genymobile/scrcpy/blob/v3.3.4/app/src/control_msg.c) defines input and clipboard packets.
- Installed Next.js guides read: `01-app/01-getting-started/15-route-handlers.md`, `01-app/02-guides/custom-server.md`, `01-app/02-guides/backend-for-frontend.md`, and `01-app/03-api-reference/03-file-conventions/instrumentation.md`.
