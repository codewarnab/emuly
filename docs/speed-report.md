# Emuly speed and smoothness report

Analysis date: 2026-11-15. Checkout: `db8b900`, branch `feat/device-presets`.

## 1. Top five findings

1. **Android itself is slow.** The replacement Tablet exposes one Android CPU core, despite using a four-core Codespace. Settings reported 26 slow frames from 26 rendered frames. Its median frame time was 900 ms.
2. **The browser can abandon a working stream too early.** The first video packet arrived 6.543 seconds after WebSocket opening. The browser allows six seconds before retrying. Decoder and painting time would add more delay.
3. **Boot deliberately opens Settings and returns Home.** `boot.sh` schedules this after Android reports boot completion. This directly explains the Settings opening and closing symptom without requiring a network disconnect.
4. **A failed screenshot can disconnect every viewer.** Screenshot requests share a connection entry with video streams. A network failure or timeout closes that entry and aborts its streams. A screenshot timeout occurred during this analysis; simultaneous video disconnection was not reproduced.
5. **The original frame counts do not establish a 1–3 fps rendering ceiling.** The log counts binary packets, including configuration packets. scrcpy sends frames when content changes. However, measured scrolling and Android rendering statistics confirm real smoothness problems.

### Evidence labels

- **Measured:** observed during this run, with timing or log evidence.
- **Code-confirmed:** directly established by current control flow; browser reproduction may remain untested.
- **Likely:** evidence supports the explanation, but does not establish the exact historical trigger.
- **Speculative:** a proposed improvement needs an experiment before adoption.

### Scope and authorization

The original `phone-misty-osprey` was already deleted. Its local record said `deleted`; the correct GitHub account had zero Codespaces.

The user subsequently authorized creating a replacement. One Tablet, `phone-sandy-tiger`, was created through the local Emuly API. No other phone was modified or deleted.

The user approved GitHub CLI diagnostics and restarting localhost with supported self-host authentication. Measurements used `ditipriya02` and localhost:4321. No Docker setup was added. No browser was used after the user requested CLI-only diagnostics.

This report measures a replacement phone, rather than reproducing the original phone's exact state. No stop/wake cycle was needed: creation included a cold Android boot.

## 2. Measured timelines

### Creation and cold boot

The HTTP create request began at **16:52:44.415 UTC**. It returned the phone ID at **16:52:51.459 UTC**, after **7.044 seconds**.

The built-in diagnostic operation began at **16:52:47.335 UTC**. The following offsets use that origin. Nested durations overlap; they must not be added together.

| Stage | Offset from diagnostic start | Measured duration or interpretation |
| --- | ---: | --- |
| Request accepted | 0.008 s | Server observation |
| GitHub creation completed | 4.045 s | Provider request took 2.520 s |
| Provider became available | 42.296 s | Polling observation; provider wait recorded 42.297 s |
| Setup check completed | 78.735 s | 36.434 s, including connection and remote setup |
| First forwarded health probe | 79.033 s | Failed with HTTP 404 in 0.240 s |
| Tunnel relay connected | 80.690 s | Relay connection took 0.353 s; metadata lookup preceded it |
| First `/boot` attempt ended | 89.413 s | Failed transport call; Android continued booting |
| Android readiness confirmed | 195.240 s | Approximately 3 minutes 15 seconds from diagnostic start |
| Create operation completed | 195.245 s | 16:56:02.580 UTC |
| CLI poll observed ready | 196.640 s | 16:56:03.975 UTC; five-second polling interval |

Creation-to-ready was **198.165 seconds**, measured from the external HTTP request start.

The server recorded:

```text
[runner] phone-sandy-tiger-… /boot failed: TypeError (UND_ERR_SOCKET)
[boot] phone-sandy-tiger: /boot did not confirm Android Error: Phone connection failed (/boot). Try again.
[boot] phone-sandy-tiger: Android still booting; the next sync joins this boot
```

The recovery worked. A failed `/boot` response did not mean that Android had stopped.

### Page HTTP request and first video

These are CLI HTTP and WebSocket measurements. They exclude browser JavaScript download, hydration, decoding, and actual screen painting.

| Stage | First connection after boot | Later auto-quality connection |
| --- | ---: | ---: |
| Page HTTP body completed | 1.681 s | 0.941 s |
| Ticket POST completed | 1.196 s | 0.082 s |
| WebSocket opened after ticket | 3.536 s | 1.713 s |
| First non-configuration video packet after socket creation | 10.079 s | 3.567 s |
| First video packet after WebSocket opening | **6.543 s** | **1.854 s** |
| Sequential page request through first video packet | **12.956 s** | **4.590 s** |

The runner independently logged:

```text
[scrcpy] start jar=336 scrcpy=1492 first_packet=6546
[scrcpy] start jar=17 scrcpy=958 first_packet=1802
```

These runner times start when scrcpy startup begins. `first_packet` can include codec configuration. They are not browser paint times.

The CLI deliberately kept waiting beyond six seconds. The current browser timeout would have expired before the first connection delivered its video packet.

### Motion, network, screenshots, and Android

| Measurement | Result | Limits |
| --- | --- | --- |
| Auto-quality Settings scrolling | 172 video packets over a 19.678 s packet span; about 8.7 packets/s | Forty wheel events, every 500 ms; not decoded browser fps |
| Packet gaps during that scroll | Median 82 ms; p95 203 ms | Includes periods without screen updates |
| Application ping/pong during auto run | Usually 47–71 ms; later samples reached 129, 543, and 659 ms | Includes scheduling and relay delays; not pure network latency |
| Opening Settings through HTTP adb | 1.895 s | Command completion, not input-to-painted-response latency |
| First screenshot attempt | HTTP 502 after approximately 23.1 s | Server logged `/screenshot failed: TimeoutError` |
| Later screenshot during an open video connection | HTTP 200, 141,139 bytes, 2.034 s | Stream remained connected until deliberate client closure |
| Android Settings graphics statistics | 26/26 frames janky; median 900 ms, p90 3200 ms, p95 3250 ms | Cumulative Android statistics; includes startup and interaction |
| Guest CPU configuration | CPU `0` only; `hw.cpu.ncore = 1` | Confirmed through guest sysfs and effective emulator configuration |
| Guest RAM | Effective configuration 4096 MB; guest MemTotal 4,014,504 kB | Raw AVD config said 96M, but emulator increased RAM automatically |
| Host sample during boot | Four CPUs; interval I/O wait 11–41% | Short `vmstat` sample, not a sustained profile |

A later saver-quality run delivered only 35 video packets over its whole session. It had no video packets during the designated scrolling phase. Some ping replies took 0.7–2.944 seconds. Conditions changed between runs, so this does **not** prove that saver quality caused the slowdown.

The original user logs reported 47 binary packets in 36.599 seconds and 165 in 61.797 seconds. Those averages are 1.28 and 2.67 packets/s. They cannot distinguish static content from rendering stalls.

## 3. Causes of the reported symptoms

### Black screen after spawning

**Measured and code-confirmed:** Android readiness does not guarantee a responsive launcher or an available encoded frame.

`phone/runner/runner.mjs:65` checks `sys.boot_completed`. `phone/scripts/boot.sh:129` waits for that property, rather than launcher responsiveness. The page mounts its screen when stored Android state becomes ready (`app/(app)/app/phones/[id]/page.tsx:141`).

The new Tablet continued reporting startup failures after readiness. Android's event log contained:

```text
16:56:20 am_anr: com.google.android.inputmethod.latin — failed to complete startup
16:56:27 am_anr: com.google.android.gms.persistent — failed to complete startup
16:56:30 am_anr: com.google.android.googlequicksearchbox:interactor — failed to complete startup
16:56:34 am_anr: com.google.android.gms — failed to complete startup
16:56:53 am_anr: com.google.android.gms — broadcast timeout
```

`am_anr` means Android recorded an application that was not responding. These are actual replacement-phone observations. They do not prove that Play updates were downloading or installing.

Meanwhile, `components/phone/phone-video-connection.ts:199` gives the first painted frame six seconds after WebSocket opening. The measured first packet exceeded that deadline. The browser would retry before decoding could begin.

Fallback images do not guarantee an immediate picture. `components/phone/phone-screen.tsx:79` starts a PNG connection alongside video. Its poll awaits that connection before attempting HTTP fallback (`:90`). PNG connection opening allows ten seconds, followed by a fifteen-second frame wait (`components/phone/png-connection.ts:25`, `:35`). The subsequent HTTP screenshot can also be slow.

**Likely historical explanation:** slow Android startup combines with premature video retries and slow screenshots. The exact original black-screen sequence remains unobserved.

### Icons disappear; Settings opens and closes

**Code-confirmed:** `phone/scripts/boot.sh:34` contains `redraw_home()`.

It waits twenty seconds, checks whether the launcher has focus, opens Settings, waits two seconds, and sends Home. The script explicitly describes this as a workaround for a launcher that shows wallpaper without icons.

This sequence directly matches Settings opening and closing. It does not require a stream disconnection. It can also interrupt a user who opens another app after the initial focus check.

**Measured:** the replacement launcher used 10% guest CPU in one `dumpsys cpuinfo` sample. Android also reported several startup ANRs. **Unproven:** a launcher or SystemUI crash caused the original missing icons. No original crash trace survives in this analysis.

### Slow taps and uneven motion

**Measured:** Settings rendering was already slow inside Android. Its 900 ms median frame time greatly exceeded the usual approximately 50 ms ping replies. Reducing transport latency alone cannot remove that rendering delay.

The host supplied four cores and 16 GB RAM. Android exposed one virtual CPU. The effective graphics mode was SwiftShader, which renders using software. The Tablet rendered at **2560 × 1600**, or **4,096,000 pixels**.

`phone/scripts/setup.sh:112` creates the AVD without an explicit CPU setting. `phone/scripts/boot.sh:109` supplies no `-cores` override. It requests software graphics, disables Vulkan, and disables snapshots. Effective configuration and runtime logs confirmed the one-core guest and SwiftShader renderer.

KVM existed and setup reported it accessible. CPU virtualization and GPU acceleration are separate features. Calling this machine simply “without KVM” would be incorrect. [Android acceleration documentation](https://developer.android.com/studio/run/emulator-acceleration).

One guest CPU, software rendering, a large display, and startup application contention are strong contributors. Host I/O wait also contributed during the sampled boot interval. Their individual shares were not isolated experimentally.

Input has additional delays during fallback. `components/phone/phone-screen.tsx:181` serializes HTTP input. PNG capture then waits one second after each completed screenshot (`lib/phone/png-stream.ts:28`). A 2.034-second capture would yield roughly one image every three seconds before other overhead.

### Uncaught ECONNRESET and `lease_abort`

These logs describe different events. They should not be treated as one established cause.

**Code-confirmed:** `lib/phone/phone-stream-proxy.mjs:93` assigns `closer=lease_abort` when the shared lease signal aborts. `lib/phone/phone-link.ts:56` closes an entry by aborting that signal. Causes include explicit phone lifecycle changes and connection failures.

`lib/phone/phone-link.ts:327` closes the shared connection after a screenshot network failure or timeout. Every viewer using that entry then loses its lease. HTTP error responses use a different branch and do not automatically close the entry.

The screenshot timeout happened in this run. However, it did not establish the historical cause of the original 36.599-second and 61.797-second closures. Those logs lack the initiating operation and abort reason.

The connection's 120-second idle timer only starts after all active users release it (`lib/phone/phone-link.ts:109`). An active stream holds a reference. The sixty-second keep-awake interval is not a sixty-second stream lifetime. A failed keep-awake call logs a warning rather than directly closing the connection.

**Remaining error-handler gap:** the raw socket's error handler is attached at `lib/phone/phone-stream-proxy.mjs:80`, after awaiting shared-ticket lookup at `:62`. A reset during that asynchronous lookup has no handler supplied by this function. The PNG branch returns before reaching that handler.

The existing handler already protects the later `ticket.open()` wait. Therefore, claiming that this entire wait still lacks protection would be wrong.

**Likely risk, not reproduced:** an unhandled socket `error` can become an uncaught exception. Next's development runtime may intercept and report it; plain Node can terminate. The exact historical stack and emitting object were unavailable. No deliberate crash experiment was performed against the active server.

## 4. Bug list

P1 means a major usability or availability problem. P2 means a narrower functional problem. P3 means misleading diagnostics.

| Bug | Severity and evidence | Reproduction | Suggested fix and files |
| --- | --- | --- | --- |
| First-frame deadline expires before a healthy cold stream produces video | P1; measured packet arrival beyond the configured deadline | Open a newly ready, busy Tablet. Observe WebSocket open, then no picture before six seconds. This run needed 6.543 seconds just for the packet. | Align the browser deadline with capture startup. Report capture progress and retain a bounded overall deadline. Start with `components/phone/phone-video-connection.ts:199` and `phone/runner/scrcpy.mjs:33`. |
| Screenshot failure aborts unrelated video viewers | P1; code-confirmed; screenshot timeout measured separately | Keep video open, then cause a screenshot transport timeout on the same phone. Inspect the shared abort signal and viewer closures. Successful screenshot concurrency did not disconnect video here. | Separate request failure from shared connection invalidation. Close the connection only after evidence that it is unusable. `lib/phone/phone-link.ts:306`. |
| Raw socket protection starts after asynchronous authentication work | P1 potential availability impact; code-confirmed gap, crash untested | Reset an upgrade socket while shared-ticket storage is delayed. Also cover the PNG upgrade branch. Use an isolated disposable server for this experiment. | Attach error/close handling immediately upon matching a phone upgrade. Handle rejected asynchronous upgrade work explicitly. `lib/phone/phone-stream-proxy.mjs:50`. |
| Boot changes the user's active app after reporting ready | P2; code-confirmed | Remain on Home after cold boot. Around twenty seconds later, Settings opens and Home follows. Enter another app between the focus check and Home command to expose the race. | Complete any required launcher recovery before readiness. Avoid unconditional delayed Home after the user gains control. `phone/scripts/boot.sh:34`. |
| Visibility resume uses a resettable fps counter as proof of an existing picture | P2; code-confirmed, browser reproduction untested | After a stats update resets `frames` to zero, briefly hide and restore a static screen. No new frame arrives, so the five-second resume timer reconnects. | Track successful painting independently from the per-second counter. `components/phone/phone-video-connection.ts:189`, `:261`. |
| Runner freshness check can accept stale scripts | P2; code-confirmed, upgrade scenario untested | Keep an existing protocol-version-10 runner with an old scripts hash. The strict quick check fails, but setup then accepts version 10 alone. | Compare the expected scripts hash in both shell health checks before returning ready. `lib/phone/phone-setup.ts:71`, `:85`, `:167`. |
| Reported stream delay excludes Android rendering and encoding | P3; code-confirmed | Make Android rendering slow while transport remains fast. The displayed delay can stay low despite slow visible feedback. | Name the metric precisely. Add input-to-visible-response and capture-age measurements separately. `phone/runner/scrcpy-protocol.mjs:70`, `components/phone/phone-video-connection.ts:182`. |
| Stream log calls all binary packets “frames” | P3; code-confirmed | Compare binary packet count with codec configuration and decoded picture counts. Static content also lowers packet frequency. | Count configuration packets, video packets, decoded frames, and painted frames separately. `lib/phone/phone-stream-proxy.mjs:183`. |

### Suspected causes that current code does not establish

`PhoneRefresh` uses SSE and calls `router.refresh()` (`components/phone/phone-mutations.tsx:141`). The current Next documentation says refresh preserves unaffected client state. The screen key is the stable phone ID. Ordinary refresh therefore does not prove a stream remount.

The conditional screen does unmount when stored readiness becomes false. That can amplify genuine provider-state transitions. Browser traces are needed to count those remounts.

The preview component currently has **no periodic screenshot interval**. It captures when visible, when visibility resumes, and after `emuly:changed` events (`components/phone/phone-preview.tsx:48`). Multiple visible tabs can still request captures.

Strict Mode can repeat effect setup in development. It does not explain periodic production closures without additional evidence.

The user also reported constant refreshes on `/`. A twenty-second CLI HMR connection received `turbopack-connected` and `sync`, with no reload message or unexpected disconnection. The landing page does not mount `PhoneRefresh`. The browser refresh loop was not reproduced, and its cause remains unresolved.

## 5. Improvements ranked by impact versus effort

Expected gains below are estimates unless explicitly marked measured. No proposed tuning or fix was applied.

### Highest priority

| Rank | Improvement and evidence | Expected gain | Effort | Risk | Files |
| --- | --- | --- | --- | --- | --- |
| 1 | Give Android an explicit CPU budget; compare two and four guest cores. **Likely**, supported by the measured one-core guest. | Reduce startup contention and app stalls. No defensible percentage is available without an A/B run. | Small change; medium validation | Four guest cores compete with software graphics and encoding on the four-core host. Begin with two. | `phone/scripts/setup.sh`, `phone/scripts/boot.sh` |
| 2 | Reduce the Tablet's Android render resolution while preserving logical size through proportional density. **Likely**. | 1280×800 instead of 2560×1600 removes 75% of rendered pixels. Frame-time improvement will be smaller and requires measurement. | Medium | App compatibility, screenshots, text quality, and coordinate mapping need validation. Preserve an option for full resolution. | `lib/shared/device-presets.ts`, `phone/scripts/boot.sh`, screen input mapping |
| 3 | Fix first-frame timeout and static-screen resume. **Measured/code-confirmed**. | Avoid the measured premature retry and unnecessary tab-resume reconnects. Preserve the existing connection and image. | Small | Longer deadlines must still detect genuinely dead capture sessions. | `components/phone/phone-video-connection.ts` |
| 4 | Isolate screenshot failures from video connection lifetime. **Code-confirmed**. | Prevent a failed thumbnail or fallback capture from disconnecting unrelated viewers. | Medium | Avoid retaining genuinely broken tunnels indefinitely. | `lib/phone/phone-link.ts`, `lib/phone/runner-frame.ts` |
| 5 | Make launcher recovery part of readiness, with a bounded settling check. **Likely**, supported by post-ready ANRs. | Remove the surprise Settings/Home transition. Replace early false readiness with an honest startup state. | Medium | Waiting for complete system idleness can stall forever. Use bounded checks and preserve diagnostic detail. | `phone/scripts/boot.sh`, `phone/runner/runner.mjs`, `lib/phone/phone-mutations.ts` |

### Next improvements

| Rank | Improvement and evidence | Expected gain | Effort | Risk | Files |
| --- | --- | --- | --- | --- | --- |
| 6 | Close the raw-socket error-handler gap; preserve the initiating abort reason. **Code-confirmed gap**. | Prevent avoidable uncaught errors and make `lease_abort` actionable. No measured speed gain. | Small–medium | Avoid double teardown and leaking leases during early socket closure. | `lib/phone/phone-stream-proxy.mjs`, `lib/phone/phone-link.ts`, diagnostics |
| 7 | Share one Android capture/encoder across compatible viewers. **Likely**. The bridge is shared today; the encoder is not. | With N equivalent viewers, potentially reduce encoder processes from N to one. Cache configuration and a keyframe for quick joining. | Large | Slow viewers need independent queues. Quality settings and independent controls need explicit policy. | `phone/runner/runner.mjs:352`, `phone/runner/scrcpy.mjs`, stream proxy |
| 8 | Derive a small first still image from shared capture. **Speculative**. | Avoid a second expensive full-resolution adb screenshot during startup. The measured screenshot cost was 2.034 s when successful. | Medium–large | Cached images must show their age. Separate capture/decoding infrastructure may be needed. | Runner capture manager, `lib/phone/png-stream.ts`, `components/phone/phone-screen.tsx` |
| 9 | Adapt capture size, bitrate, and frame rate using sustained measurements. **Likely**. | Recover from congestion without restarting capture for every brief delay spike. | Medium–large | Quality oscillation and decoder reconfiguration can introduce stalls. | `components/phone/phone-video-connection.ts`, `components/phone/use-phone-video.ts`, runner protocol |
| 10 | Replace large latency queues with bounded frame-age recovery and a requested keyframe. **Likely**. | Reduce stale video after congestion. Four MiB corresponds to roughly 8.4 seconds at the configured auto bitrate. | Medium–large | Arbitrarily dropping H.264 delta frames corrupts decoding. Resume only with valid configuration and a keyframe. | `phone/runner/scrcpy.mjs:88`, `lib/phone/phone-stream-proxy.mjs:181`, video decoder |

The four-MiB conversion is a capacity calculation, not measured buffering. Bitrate varies. Limits exist at more than one hop.

The current adaptive path already switches auto quality to saver when measured delay exceeds 350 ms or decoding backs up. It recreates the connection through the hook dependency list (`components/phone/use-phone-video.ts:44`). Saver remains selected for that mounted hook. A sustained threshold, recovery path, and hysteresis would improve this behavior.

The decoder currently closes the socket when its queue exceeds five (`components/phone/phone-video-connection.ts:228`). The runner already understands a `keyframe` control message (`phone/runner/scrcpy-protocol.mjs:11`). Controlled recovery should use that capability before introducing a new transport.

### Larger experiments and lower-priority options

| Option | Evidence and expected gain | Effort and risk | Files or area |
| --- | --- | --- | --- |
| Prewarm capture near the end of boot | **Speculative.** Move some measured capture startup work before page opening. Discard stale frames and wait for usable Android state. | Medium–large. Encoding during a busy boot may delay Android further. | Boot orchestration, runner capture manager |
| Validate prebuild warming and selective background-app tuning | **Likely opportunity.** `prebuild.sh` already boots Android and waits another sixty seconds when possible. Confirm that this actually occurs for deployed templates. | Medium. Disabling Google components can break authentication, keyboards, notifications, or app behavior. Use a separate minimal image for experiments. | `phone/scripts/prebuild.sh:22`, `setup.sh`, devcontainer |
| Benchmark a supported software graphics backend and snapshots | **Speculative.** Runtime emulator was 37.2.13.0. Avoid assuming a deprecated flag gives best performance. | Medium. Graphics compatibility and large snapshot I/O can outweigh startup gains. | `phone/scripts/boot.sh:109`, emulator image |
| Skip the Next video relay through a short-lived authenticated stream endpoint | **Speculative.** Removes one application relay and its copy/buffering work. It cannot fix 900 ms Android rendering. | Large. Requires scoped ephemeral authorization, revocation, origin checks, and a reachable endpoint. Never send the GitHub token to browser JavaScript. | Stream-ticket API, runner gateway, browser connection |
| Evaluate WebRTC and optimistic tap feedback separately | **Speculative.** WebRTC may improve congestion behavior. A local tap marker can provide immediate acknowledgement. | Large for WebRTC: Codespaces reachability, TURN relay, signaling, encoding integration, and operational cost. Small for tap feedback: it must distinguish “sent” from “Android responded.” | New transport infrastructure; `components/phone/phone-screen.tsx` for tap feedback |

The boot script documents older measurements where cold boot beat snapshot loading: 108–145 s versus 163–201 s. These are historical comments, not fresh results from this run. Do not enable snapshots based only on the phrase “quick boot.”

Android documents separate software graphics modes and flags that vary by emulator version. Verify the installed version's behavior before changing graphics settings. [Android acceleration documentation](https://developer.android.com/studio/run/emulator-acceleration), [command-line documentation](https://developer.android.com/studio/run/emulator-commandline).

### Existing implementation worth preserving

Video already uses **H.264 and browser WebCodecs**, with latency optimization. Adding WebCodecs is not a new improvement here.

Current quality settings are:

| Quality | Maximum encoded edge | Maximum fps | Target bitrate |
| --- | ---: | ---: | ---: |
| Auto | 1080 px | 30 | 4 Mbps |
| Sharp | 1080 px | 30 | 8 Mbps |
| Saver | 720 px | 15 | 1.5 Mbps |

These are encoder limits, not guaranteed observed performance. Lower encoded resolution does not lower Android's underlying 2560×1600 rendering resolution. scrcpy documents variable frame production when content changes. [scrcpy 3.3.4 video documentation](https://github.com/Genymobile/scrcpy/blob/v3.3.4/doc/video.md).

Video is binary H.264. It is not base64 or JSON-wrapped. The runner converts scrcpy's twelve-byte packet header into a seventeen-byte browser header. JSON is used for small control messages.

The path is:

```text
Browser / CLI client
  -> localhost Next stream proxy
  -> GitHub forwarded endpoint OR development tunnel
  -> runner WebSocket
  -> adb forwarding
  -> Android scrcpy video and control sockets
```

The replacement's measured video sessions used `route=forwarded`. The original supplied logs used `route=tunnel`. Setup also used a tunnel after its initial forwarded probe failed. These paths should not be treated as identical network measurements.

The installed `ws` implementation calls `socket.setNoDelay()` (`node_modules/ws/lib/websocket.js:261`). Adding that call again to WebSocket connections is not an evidence-backed optimization. Inner adb/socket behavior was not isolated.

The runner currently pushes the scrcpy jar for every connection. Its cleanup setting deletes that jar. Removing repeated pushes without changing cleanup semantics would break later viewers. The measured warm push took seventeen milliseconds; it is not a leading bottleneck.

## 6. What could not be tested

| Missing measurement | Reason and consequence |
| --- | --- |
| Original phone reproduction | `phone-misty-osprey` was deleted before testing. Replacement results cannot establish its exact historical failure sequence. |
| Browser painting, decode drops, hydration, and input-to-photon latency | The user requested CLI-only work. Playwright was unavailable and no package was installed. Received packets are not painted frames. |
| Constant browser refresh loop | User closed the affected tab. CLI HMR remained stable during its twenty-second probe. Cause remains open. |
| Exact source of historical uncaught ECONNRESET | No complete original stack or socket trace. A current handler gap was identified without deliberately crashing the server. |
| Original lease-abort initiator | Historical logs contain the result, but not the originating request or invalidation reason. |
| Controlled two-core/four-core or resolution comparison | Product tuning was outside the report-only scope. No emulator configuration was changed for an experiment. |
| Sustained encoder profiling and exact dropped-frame attribution | Android graphics statistics and packet timing were available. No complete producer-to-browser frame trace was collected. |
| Multi-viewer encoder scaling and visibility behavior | Code was traced, but no real browser tabs were used. |
| Production performance | Local development compilation contributed to first page and ticket timings. No production build or hosted browser benchmark was performed. |
| Clean auto/saver comparison | Runs occurred at different boot ages and system loads. Saver results cannot establish a causal quality comparison. |

The first CLI attempt to open Settings returned HTTP 403 because its request lacked an Origin header. The harness was corrected, and later requests returned HTTP 200. This harness error is not listed as a product bug.

No automated test suite was run. This report uses source inspection, supported HTTP requests, WebSocket probes, read-only SQLite diagnostics, and authorized Codespace commands.

## 7. Cleanup and final state

No product code was changed. No temporary `EMULY-DEBUG` statements were added. No commit, push, stash, reset, or branch switch was performed.

The replacement phone remains available with its configured thirty-minute idle timeout. No phone was stopped or deleted during this analysis. The active GitHub CLI account remains `ditipriya02`, as requested.

The local development server started for this analysis was stopped. Temporary CLI probe files were removed. The replacement Codespace was last verified `Available`, with Android `ready`.

The source scan found no `EMULY-DEBUG` statements. Final `git status --short` showed only:

```text
?? docs/speed-report.md
```

`git diff --stat` was empty because the report is a new, untracked file. No existing tracked file changed.

