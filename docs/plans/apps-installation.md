# Apps: APK upload and installation from URL

Status: proposed, 2026-11-08. Research and implementation plan only.

## 1. Outcome

Users can install an Android app through either option in the Apps tab:

1. Drop an APK file, or choose it through **Upload APK**.
2. Paste a direct HTTPS download link into **Install from URL**.

Both options show progress and produce the same installed-app entry.
Users can open an installed app from that entry.
Installation never opens the app automatically.

This plan supersedes the URL-only restriction in `docs/PLAN-WEB.md`, section 1.
That restriction is historical scope, rather than a verified upload limitation.
Update that document when implementation begins.

### Initial scope

- One standalone `.apk` per installation, including signed debug APKs.
- Upload, URL download, installation status, installed-app listing, and Open.
- Updates that preserve existing app data when Android accepts the signing certificate and version.
- Recoverable status after navigation, connection loss, and web-server restart.
- Actionable errors without exposing credentials or raw command output.

Split APK sets, `.apks`, `.xapk`, `.aab`, batch installation, and authenticated download flows are deferred.
Uninstall is also deferred. It deletes app data and needs a separate, explicit product decision.
The existing project promises one destructive action; this feature must not silently expand that promise.

## 2. Findings from the current source

| Source | Verified behavior | Required change |
|---|---|---|
| `app/(app)/app/phones/[id]/page.tsx` | Both Apps views pass empty rows to `LogFeed`. | Mount a real Apps panel for stored phones; keep mock mode honest. |
| `phone/runner/runner.mjs` | Already provides `POST /install` with a URL and `GET /apps`. | Replace the installer with a bounded, durable operation. Expose app inventory through the web API. |
| Existing `/install` | Uses unrestricted fetch redirects, buffers the complete response, and installs a temporary APK. | Validate destinations, limit bytes, stream to disk, and report operation stages. |
| Existing `/install` | Finds a new package by comparing lists before and after installation. | Read the APK package ID before installation. Updates do not add a new package. |
| Existing `/apps` | Lists third-party packages with version codes. | Define the inventory contract, refresh behavior, and launch availability. |
| Runner request reader | Accepts JSON bodies up to 1,000,000 bytes. | Add a separate binary upload path. Do not encode APKs as JSON or base64. |
| `lib/phone-link.ts` | Allows six runner paths, serializes JSON, and buffers responses. Most requests time out after 20 seconds. | Add explicit Apps operations and bounded binary transport. Preserve typed runner errors. |
| `lib/phone-link.ts` | Probes private forwarded HTTP, then falls back to a Dev Tunnel. Mutations are not replayed. | Verify both transports for upload. Retain the no-blind-replay rule. |
| `lib/phone-runner.ts` | Checks ownership and account state before reaching a runner. | Reuse ownership checks and require Android readiness for Apps mutations. |
| `lib/phone-setup.ts` | Copies a fixed file list and accepts runner health version 3. | Ship new modules and negotiate Apps capabilities on existing phones. |
| Runner startup | Binds loopback; `PHONE_SECRET` authentication is optional. | Keep runner ports private. Verify the deployed access boundary before enabling new routes. |
| `phone/scripts/setup.sh` | Provisions an API 36 x86_64 emulator and SDK command-line tools. | Check actual ABI support, Java, APK inspection tools, and isolation support. |
| `server.mjs`, `package.json` | Uses a custom Node server and Next.js 16.4.5. | Design for this runtime, rather than assuming serverless upload limits. |
| `lib/webhook-security.ts` | Has public-address checks and a pinned-address HTTP sender. | Reuse or extract reviewed URL policy where appropriate; APK redirects require additional handling. |

The working tree already contains unrelated application changes.
Implementation must preserve those changes and inspect the latest files before editing.

## 3. Research and design decisions

### Android installation

Android documents APK installation through ADB and replacement through `-r`.
Use an explicitly selected emulator serial for every command.
Use `-t` only when validated APK metadata marks a test-only build.
Do not grant all permissions, permit downgrades, or bypass low-target restrictions by default.
Android Package Manager remains the final compatibility authority.

Source: [Android ADB reference](https://developer.android.com/tools/adb).

Read the package ID, version code, minimum SDK, and test-only flag before installation.
Use the SDK's APK inspection tools instead of parsing binary manifests in application code.
Inspect supported ABIs when available; explain incompatible native libraries clearly.
Do not assume every ARM-only APK works on this x86_64 image.

Source: [APK Analyzer command-line reference](https://developer.android.com/tools/apkanalyzer).

Verify APK signatures through SDK tooling before attempting installation.
A valid signature establishes package integrity; it does not establish publisher trust or app safety.
Do not re-sign uploaded APKs.

Source: [apksigner reference](https://developer.android.com/tools/apksigner).

### File handling

Treat extensions and MIME types as hints, rather than proof that bytes form an APK.
Generate storage names, enforce byte limits, and keep temporary files outside served directories.
Never unpack arbitrary archives into the application tree.

Source: [OWASP file upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).

### URL handling

URL downloads create server-side request forgery risk: a supplied URL can target internal services.
Validate every redirect and pin checked DNS answers to the actual connection.
Apply this policy where the download occurs, inside the Codespace runner.
Validation on the web server alone cannot protect the runner's network.

Source: [OWASP SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

### Browser and framework

Use sequential binary chunks with acknowledged byte counts for upload progress.
XHR progress can improve feedback within each chunk, but it cannot prove runner persistence.
Display runner-acknowledged progress as the authoritative value.

Source: [MDN XMLHttpRequest upload](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/upload).

Use Node Route Handlers with Web Request/Response APIs.
Read bounded binary chunks directly; avoid whole-file `formData()` or `arrayBuffer()` processing.
Await dynamic route parameters, following this installed Next.js version.
Return private, no-store responses. Do not cache user-specific inventory or operation status.

Local reference inspected: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`.
Review relevant local caching and route configuration guides again during implementation.

## 4. Product behavior

### Apps tab layout

Show **Upload APK** and **Install from URL** together above the installed-app list.
The upload area supports drag and drop, a keyboard-accessible file picker, and mobile file selection.
Show accepted format and the size limit before selection.
Dropping one valid file starts upload and installation without another confirmation.
The URL field has a labelled **Install** button and inline validation.

Show one active operation card with the source, current stage, progress, and relevant action.
Use native controls, visible focus styles, and polite status announcements.
Do not announce every byte change to screen readers.
Keep screen controls usable during downloads and uploads.

### User-visible states

| State | UI behavior |
|---|---|
| Loading inventory | Show a loading message, rather than an empty list. |
| No third-party apps | Say “No user-installed apps yet.” Android's bundled apps still exist. |
| Phone stopped or booting | Explain “Start the phone to install apps.” Disable installation without accepting files. |
| Uploading | Show acknowledged bytes and total size. Offer Cancel. |
| Downloading | Show received bytes; show a percentage only when a trustworthy total is available. Offer Cancel. |
| Checking APK | Show an indeterminate progress indicator. Offer Cancel before installation starts. |
| Installing | Show an indeterminate indicator. Explain that leaving this tab does not cancel installation. |
| Installed | Refresh inventory and show Open when a launchable activity exists. |
| Failed | Keep a clear error and offer the appropriate retry action. |
| Connection lost | Say that status is unavailable. Reconnect and query the same operation. |

App rows show package ID and version code reliably.
Use an app label when reliable metadata exists; otherwise display the package ID.
Decorative app icons and complete metadata for externally installed packages can follow later.
Provide Refresh so apps installed through another tool appear too.
Only show the empty state after a successful inventory response.

### Updates and failures

Install accepted updates with `adb -s emulator-5554 install -r <generated-path>`.
Preserve app data. Never uninstall automatically to repair an update failure.
Distinguish certificate mismatch, version downgrade, insufficient storage, unsupported SDK, unsupported ABI, and invalid APK.
For signature mismatch, explain that the installed app uses a different signing certificate.
For split packages, request a standalone or universal APK.
For unknown outcomes, ask users to refresh status before retrying.

Open resolves the package's MAIN/LAUNCHER activity for the intended Android user.
Launch through an explicit validated component using `am start`; do not rely on random input through `monkey`.
Hide or disable Open for packages without a launcher activity.
Confirm the package still exists before launch.

## 5. Architecture

```text
Browser: Apps panel
  ├─ selected file → bounded chunks → authenticated Next routes
  └─ HTTPS URL → authenticated Next route
                               │
                    owned-phone runner transport
                               │
                  private runner operation service
                    ├─ upload staging
                    ├─ bounded HTTPS downloader
                    ├─ isolated APK inspection
                    └─ ADB install and package verification
                               │
                    operation status + inventory
```

Both sources converge on a runner-owned staged APK and the same inspection/install workflow.
The web application never stores the entire APK or fetches arbitrary download URLs.
The runner owns long operations, so a browser or Next request does not own their lifetime.
Do not add Redis, object storage, or a separate queue service for this initial implementation.

### Upload protocol

Use raw `application/octet-stream` chunks, initially capped at 4 MiB each.
Choose a proposed total APK limit of 250 MiB for both sources.
These are product defaults to verify during the transport spike, rather than measured infrastructure limits.

1. Create an operation with source `upload`, display filename, and declared size.
2. Send one chunk at a time with its starting offset and SHA-256 digest.
3. The runner persists bytes before acknowledging the next offset.
4. After all bytes arrive, explicitly complete the upload and start validation.
5. Poll the same operation until completion, then refresh inventory.

The web route buffers at most one capped chunk; the runner streams it to its staging file.
Limits apply to actual bytes even when Content-Length is missing or false.
Use generated identifiers for paths. Treat original filenames as bounded display text only.

The runner serializes writes per operation.
Persist chunk acknowledgements atomically, including the committed offset and chunk digest.
An identical repeat returns the same acknowledgement without appending bytes again.
An unexpected offset or different digest returns a conflict and the committed offset.
After a crash, truncate any uncommitted file tail before accepting more bytes.
Completion rejects incomplete files and verifies the final size and computed file digest.

If the browser refreshes mid-upload, ask users to select the file again.
V1 restarts that upload rather than promising transparent file resumption across reloads.
Within the same page session, lost acknowledgements can resume from the runner's committed offset.

### URL protocol

Create an operation with source `url` and a bounded HTTPS URL.
Return its ID promptly, then let the runner download in the background.
Use the same total-size limit and staged-file workflow as uploaded APKs.
Do not require a `.apk` URL suffix; signed links and release assets often lack one.
Reject HTML login pages through APK validation rather than trusting Content-Type.

Allow HTTPS port 443 only initially, without embedded credentials or fragments.
Accept public destinations only. Block local, private, link-local, metadata, multicast, and reserved addresses.
Check IPv4, IPv6, mapped forms, and all DNS answers.
Pin an approved address while retaining the original hostname for TLS verification and SNI.
Follow at most five redirects, revalidating each destination.
Reject HTTPS-to-HTTP redirects and never forward GitHub or runner credentials to download servers.
Disable transparent content decompression or count decoded bytes against the same cap.
Check available disk space before staging and throughout transfer.

Full signed URLs may contain secrets.
Do not persist or log full URLs in central events, operation history, telemetry, or error messages.
Keep the URL in runner memory for the active download; show a sanitized hostname to users.
After a runner restart, an interrupted download requires the user to submit the URL again.

## 6. API contracts

Use the existing `/v1/phones/[id]` convention.
Every route checks session, account state, ownership, input limits, and rate limits.
Every mutation checks same-origin requests and rejects cross-site requests before reading binary data.
Operation IDs never substitute for ownership checks.

| Web endpoint | Contract |
|---|---|
| `GET /v1/phones/[id]/apps` | Current third-party inventory with `fetchedAt`; never convert failures into an empty list. |
| `POST /v1/phones/[id]/app-installs` | Create upload or URL operation; accept an idempotency key. Return `202` and operation ID. |
| `GET /v1/phones/[id]/app-installs` | Active operation and recent outcomes for reconnect/navigation recovery. |
| `GET /v1/phones/[id]/app-installs/[operationId]` | Stage, byte counts, package metadata, cancellation availability, and safe error code. |
| `PUT /v1/phones/[id]/app-installs/[operationId]/content` | One binary chunk with validated offset and digest; return committed offset. |
| `POST /v1/phones/[id]/app-installs/[operationId]/complete` | Idempotently finalize an uploaded file; URL jobs do not use this endpoint. |
| `POST /v1/phones/[id]/app-installs/[operationId]/cancel` | Cancel pre-install work and clean staged files. Return `409` after installation begins. |
| `POST /v1/phones/[id]/apps/open` | Validate package ID and launch the resolved activity. Return a safe result. |

Runner endpoints mirror these domain operations under `/apps` and `/app-installs`.
The transport builds paths from validated IDs and explicit operations.
Do not expose a generic arbitrary-path proxy.
Preserve expected runner status and structured error codes across the web boundary.

Return `401` for missing sessions, `404` for unowned resources, `409` for unavailable phones or conflicts,
`413` for size violations, `415` for unsupported transport types, and `429` for admission limits.
Use `502`/`503` for connection or runner capability failures, without asserting installation failed.

An operation response includes:

```text
id, source, stage, bytesReceived, totalBytes?, createdAt, updatedAt,
packageId?, versionCode?, canCancel, errorCode?, message?
```

Version codes should use strings to avoid unsafe integer conversions.
Error responses never contain shell commands, filesystem paths, full URLs, or raw stderr.

## 7. Persistence, concurrency, and recovery

The runner stores private operation records under `~/emuly/data/app-installs/`.
Use generated directories with restrictive permissions, exclusive file creation, and atomic metadata replacement.
Guard against symlinks and traversal at every file boundary.
Only delete verified paths beneath the operation root.

Persist operation ID, source kind, timestamps, stage, committed offset, APK digest,
validated package metadata, prior package version, target version, and safe outcome.
Do not retain source bytes after terminal outcomes.
Do not add a central SQLite table for installation truth in v1.
Android inventory remains authoritative; runner records explain operations.
Existing central activity events may record one safe outcome per operation.
Deduplicate those events by operation ID if reconciliation reports them more than once.

```text
uploading ─────────────┐
                      ├─ validating → installing → succeeded
downloading ──────────┘                    └──────→ failed / interrupted
pre-install stages ─────────────────────────────→ cancelled / expired / failed
```

Permit one active install operation per phone. Reject a second with the existing operation ID.
Bound admission per account too; initially allow two simultaneous transfers per account.
Start with six simultaneous transfers per web process, then adjust from measurements.
This bounds one-chunk buffering near 24 MiB, plus protocol and application overhead.
Do not reuse a per-request rate limiter that would reject normal chunk traffic.
Rate-limit operation creation separately from authenticated chunk continuation.

Serialize installation with runner boot/stop lifecycle operations.
Keep screen input outside that lock.
Define a stop-request flag so installation cannot start after stopping has begun.
Cancel pre-install work on stop; let an active ADB install settle within its deadline before graceful stop.
External Codespace stop and budget protection can interrupt work and must remain effective.
An install may use a bounded activity lease, but must not disable budget safeguards or change saved idle settings.

Proposed deadlines: 30-second transfer idle timeout, 10-minute transfer deadline,
60-second inspection deadline, and five-minute ADB install deadline.
Remove abandoned uploads after 30 minutes and terminal records after 24 hours.
Enforce cleanup on startup and periodically while running.
Set a total staging quota of 512 MiB per phone and require 1 GiB free-space reserve initially.
These defaults need the disposable-environment spike before release.

Do not blindly replay create, complete, or install after a transport timeout.
Query the operation using its stable idempotency key or ID first.
Persist creation keys for the operation retention period; reject reuse with different parameters.

On runner restart, expire incomplete upload/download/validation work and clean staged bytes.
For an `installing` record, query Android before deciding the outcome.
If the prior version differed and the target version now exists, record verified success.
If the same version already existed, version equality alone cannot prove the reinstall succeeded.
Report an interrupted, uncertain outcome rather than inventing success.
Keep the existing app intact and allow an explicit new attempt after reconciliation.

## 8. Isolation and operational safety

APK bytes are untrusted input, including when the user built the app.
Do not run APKs, parsers, installers, or repository tests on the Windows host without suitable isolation.
This plan requires no APK execution or test execution during documentation work.

Before implementation testing, provision a disposable emulator environment without user credentials or mounted home directories.
Verify the boundary prevents access to host files, credentials, runtime sockets, and unnecessary network destinations.
On Linux, use verified bubblewrap restrictions or an equivalent disposable boundary.
Run APK inspection without network access, with read-only SDK/JRE access and a narrow staged-file mount.
Apply CPU, memory, output, and wall-clock limits to inspection.
Do not install missing tools through an elevated local shell as a workaround.

Production installation needs a reviewed boundary too.
Verify the emulator cannot reach host credentials, private control ports, metadata services, or unnecessary forwarded services.
Keep runner download and inspection privileges narrow. Do not execute an APK on the Codespace host.
If that boundary cannot be established, record it as a release blocker rather than assuming the Codespace is disposable.

Optional SHA-256 supplied by the user can verify expected download bytes.
Computed SHA-256 always supports integrity checks and operation reconciliation.
Neither hashing nor signature verification proves an app is harmless.

## 9. Implementation map

| File or area | Responsibility |
|---|---|
| `components/phone-apps.tsx` and scoped CSS | Upload/drop zone, URL form, operation card, inventory, Open, accessible announcements. |
| `app/(app)/app/phones/[id]/page.tsx` | Replace the Apps placeholder while preserving the current live-screen layout. |
| `app/v1/phones/[id]/apps/**`, `app-installs/**` | Thin authenticated Route Handlers using awaited route parameters. |
| `lib/phone-apps-api.ts` | Web contracts, authorization, request limits, same-origin checks, safe error mapping. |
| `lib/phone-runner.ts`, `lib/phone-link.ts` | Explicit Apps operations, binary chunks, request aborts, bounded replies, leases, capability checks. |
| `phone/runner/apps.mjs` | Runner operation lifecycle, inventory, install, launch, and durable records. |
| `phone/runner/apk-download.mjs` | HTTPS restrictions, DNS pinning, redirects, byte limits, transfer cancellation. |
| `phone/runner/runner.mjs` | Route dispatch and binary body handling before the JSON reader. Remove unsafe legacy installer. |
| `phone/scripts/setup.sh`, `start-runner.sh`, `lib/phone-setup.ts` | Tool provisioning, file distribution, negotiated runner upgrade, health verification. |
| `docs/PLAN-WEB.md` | Replace the superseded upload restriction with a link to this plan. |

Extract shared URL validation only where it reduces duplicated security policy.
Do not couple APK operations to webhook delivery or import Next-only modules into the runner.
Keep pure validation separate from network and filesystem effects.

## 10. Delivery sequence

### Phase 1 — transport and environment proof: 4–6 hours

Verify 4 MiB binary chunks through forwarded HTTP and Dev Tunnel paths.
Measure a 250 MiB transfer, request overhead, RSS, disk use, and active-screen responsiveness.
Verify Java, inspection tools, signature tooling, ABI reporting, and isolation in a disposable environment.
Inspect private-port exposure and runner authentication in the deployed setup.
Exit: documented limits and a working isolated test environment; revise proposed limits if evidence requires it.

### Phase 2 — runner operations: 8–12 hours

Implement persistence, chunk handling, URL download policy, inspection, installation, and status recovery.
Replace the legacy unbounded `/install` implementation.
Add inventory and explicit app launch, cleanup, and lifecycle coordination.
Exit: both sources reach verified installation through runner contracts.

### Phase 3 — web integration: 5–8 hours

Add owned-phone Apps routes, binary transport, safe errors, admission controls, and status polling.
Hold transport leases until chunk requests and bounded responses finish.
Cancel request transport on browser disconnect; do not cancel an accepted background install.
Exit: another user's phone or operation cannot be read, uploaded to, cancelled, or launched.

### Phase 4 — Apps interface: 5–8 hours

Build both source controls, progress, retries, inventory refresh, and Open.
Poll about every second during active operations; slow or pause when hidden.
Refresh inventory after success and on explicit Refresh; avoid constant polling when idle.
Exit: desktop drag/drop, keyboard file selection, mobile picker, and URL installation work end to end.

### Phase 5 — upgrade and acceptance: 6–10 hours

Add runner health capabilities such as `appsInventory`, `apkUpload`, `urlInstall`, and `appLaunch`.
Upgrade runner setup version and ship every new module to existing Codespaces.
Do not trust the current version-3 health shortcut for feature availability.
An old runner must show an update requirement rather than a false empty list.
Use a controlled runner restart because `start-runner.sh` terminates the runner and can interrupt the screen.
Coordinate this restart with boot/install work and verify screen reconnection without wiping the AVD.
Exit: new and existing phones pass acceptance checks and preserve installed app data across stop/wake.

Estimate: 28–44 engineering hours, plus environment-specific blockers discovered during the initial proof.
The isolation boundary and transport measurements are prerequisites, rather than assumed completed work.

## 11. Verification plan

Use the test-audit skill before adding tests.
Give each behavior one primary test owner; avoid source-string checks and tests of private call sequences.
Extend existing boundary suites when they already own the behavior.

| Boundary | Observable evidence |
|---|---|
| Web Apps API | Unauthenticated and foreign-owner requests fail before runner access, including binary routes and guessed operation IDs. |
| Upload protocol | Lost acknowledgements, duplicate chunks, offset conflicts, oversized bodies, and restart tails cannot corrupt staged bytes. |
| URL downloader | Private IPv4/IPv6 targets, redirect escapes, changed DNS answers, excess redirects, and unknown-length oversized responses are rejected. |
| Runner operations | New install, update, same-version reinstall, cancellation race, stop race, restart, disk exhaustion, and cleanup produce truthful outcomes. |
| Installed app behavior | Both sources create the correct package entry; Open launches its activity; stop/wake preserves app data. |

Use controlled URL fixtures inside the isolated environment for redirect and network tests.
Do not weaken production private-address restrictions to make test fixtures convenient.
Use small signed APK fixtures with known package IDs, versions, signing keys, and supported architectures.
Include a mismatched signing key, malformed APK, test-only build, ARM-only build, and package without a launcher.
Keep fixture signing keys test-only and clearly labelled.

Browser acceptance must cover failed downloads, URL login pages, multi-file drops, and files over the limit.
Verify navigation during installation, sign-out during upload, multiple tabs, and expired sessions.
Verify that upload progress never claims successful installation before Android confirms it.
Capture deterministic screenshots without altering original pixels when visual evidence is needed.

Run focused tests, type checking, and production build inside the approved isolation boundary.
Then run the existing full suite once if focused checks pass.
No tests or application execution are required merely to deliver this Markdown plan.

## 12. Release checklist

- [ ] Both Upload APK and Install from URL appear and work on the Apps tab.
- [ ] Existing phones receive compatible runner capabilities without losing Android data.
- [ ] Limits, URL policy, permissions, isolation, cleanup, and recovery have verified boundary evidence.
- [ ] Errors remain actionable; the UI never substitutes empty inventory or failed installation for unknown status.
- [ ] The obsolete URL-only plan restriction is updated, and unrelated working-tree changes remain intact.

## 13. Implementation status — 2026-11-08

The implementation is present in the working tree. It has not been deployed to a live Codespace.

Implemented:

- Both Upload APK / drag-and-drop and Install from URL controls.
- Sequential 4 MiB uploads with chunk hashes, durable acknowledgements, idempotent creation, and status recovery.
- Background HTTPS downloads with public-address validation, DNS pinning, redirect checks, deadlines, and byte limits.
- Runner-owned staging, a 512 MiB staging quota, a 1 GiB free-space reserve, cancellation, expiry, and cleanup.
- APK metadata inspection and signature verification inside a restricted bubblewrap environment.
- Data-preserving Android installation, known failure messages, and installed-version confirmation.
- Installed-app inventory, launcher detection, explicit Open, and inventory refresh after completion.
- Owner authorization, same-origin mutations, bounded transport, and operation admission controls.
- Runner capability detection and a Check update action for existing phones.

Verified evidence:

| Check | Result |
|---|---|
| Existing suite plus new Apps boundary tests | 104 passed in an isolated Linux environment. |
| TypeScript | `tsc --noEmit` passed after route generation. |
| Production build | `next build --webpack` passed with an offline Google Fonts fixture. The fixture was temporary and did not change application fonts. |
| Binary transport | A full 4 MiB chunk passed through the forwarding adapter and a real loopback HTTP bridge. Conflicts retained their status and mutations were not replayed. |
| Public HTTPS download | The actual downloader received 12,569,951 bytes from the public F-Droid APK endpoint within a restricted filesystem environment. Only this check enabled network access. |
| Android inspection tools | Official command-line tools 11076708 and build-tools 36.0.0 read package metadata, minimum SDK, and manifest, and verified the downloaded APK signature without network access. |
| Parser runtime | Java ran with the same memory/CPU restrictions and narrow read-only mounts. These checks identified and fixed shell interpreter access, Java PATH resolution, and an inappropriate host-wide process limit. |

The APK fixture was parsed only. It was never installed or launched.
Tests and builds did not execute repository code on the Windows host.

Still required before release:

1. Use a disposable Android emulator to verify both install paths, updates, failed signatures, ABI failures, Open, cancellation/stop races, and app data after stop/wake.
2. Verify the production guest cannot reach host control ports, credentials, metadata endpoints, or unnecessary forwarded services. This remains a release blocker.
3. Exercise actual GitHub forwarding and Dev Tunnel connections with a 250 MiB file. Record memory, disk usage, and live-screen responsiveness. The size limit remains provisional.
4. Complete desktop/mobile browser acceptance, including navigation, expired sessions, multiple tabs, and the runner upgrade/reconnection flow.

The passing automated checks do not replace these environment-specific acceptance checks.
