# Error codes

> Read this file only when an error's `docs` link points here. Read only the section for that code.

Every `/v1` error is JSON with a stable `error` code and a one-line `message`. It may also have:

- `fix`: the next call to make, with real ids. `{"same_request": true}` means send the same request again.
- `then`: the call after `fix`. `if_fix_fails`: the step when `fix` did not work.
- `retry_after` (seconds, also in the `Retry-After` header) and `max_retries`. Do not retry more often.
- `needs_user: true` and `user_url`: only the user can do this step. Give them the link and say what to do.
- `ran` (adb only): `false` = did not run, safe to retry. `true` = it ran. `"unknown"` = it may have run.

Never retry more than `max_retries` times. Then tell the user what failed.

## access_denied
The user said no on the device sign-in page. Do not ask again unless the user asks you to.

## adb_failed
The adb command failed on the phone, or its reply was lost. Read `ran`. With `ran: "unknown"`, check the
screen first (`fix`). Send the command again only if the change is not there, with an `Idempotency-Key`.

## adb_timeout
The adb command took longer than `timeout_s`. It may still have run (`ran: "unknown"`): follow `fix`. For a
slow command, send a larger `timeout_s`.

## adb_unavailable
adb on the phone is not ready, often just after boot. Wait `retry_after`, then retry.

## authorization_pending
Device sign-in: the user has not approved yet. Poll again after `interval` seconds.

## bad_event
A webhook event name is not known. Use `"*"` or names from `GET /v1/webhooks`.

## bad_signature
A signed request did not match. Do not retry with the same body.

## busy
Another request for this phone is still running. Wait `retry_after` seconds and send the same request,
at most `max_retries` times.

## connection_unavailable
Emuly could not reach the phone. Read the phone with `GET /v1/phones/<id>` before you retry.

## denied
The user kept the phone on the delete approval page. Do not delete it.

## direct_upload_unavailable
The direct upload route is off for this phone. Use `POST /v1/phones/<id>/app-installs`, or the CLI.

## expired_token
The device code or setup code is too old. Start the sign-in again with `POST /v1/agent/device`.

## forbidden
The request is not allowed: a cross-site call, or an agent key without this right. If the body has
`manage_url`, give the user that link. Do not work around a 403.

## github_refused
GitHub said no. `reason` says why:

| `reason` | What to do |
|---|---|
| `billing` | The Codespaces hours or spending limit ran out. Give the user `user_url`. Do not retry. |
| `signed_out` | The GitHub sign-in is gone. The user signs in again (`fix`). |
| `sso_required` | The organization needs SAML sign-in. Give the user `user_url`. |
| `org_blocked` | The organization blocks Emuly. The user requests org access at `user_url`, or uses another repository. |
| `no_access` | The account cannot use the template repository. Tell the user. |
| `machine_unavailable` | GitHub has no such machine in this region now. Tell the user. |
| `rate_limited` | GitHub is busy. Wait `retry_after`, then send the same request. |
| `github_down` | GitHub had an error. Wait `retry_after`, then send the same request. |
| `other` | Show `message` to the user. |

## invalid_code
The setup code or device code is wrong. Check it, or start the sign-in again.

## invalid_grant
The sign-in grant is not valid any more. Start the sign-in again with `POST /v1/agent/device`.

## invalid_input
Your request is wrong. `field` names the bad key (or `header` the bad header). `allowed` lists the
values or gives `{min, max}`. Fix the request. Do not send it again unchanged.

## invalid_path
The path in the request (for example an adb file path) is not allowed. Change it.

## invalid_request
The request is missing a part or has a wrong shape. Read `message` and fix the request.

## invalid_response
The phone sent a reply Emuly could not read. Retry once. If it fails again, read the phone's state.

## limit_reached
The account has its most phones. List them (`fix`) and reuse one. Ask the user before you delete a phone.

## method_not_allowed
This path does not take this HTTP method. Check the method in `references/tasks/phones.md`.

## not_available
This feature is not on for this server or phone. Do not retry.

## not_found
No such phone (or webhook, or request) on this account. List with `GET /v1/phones` and use a real id.

## output_too_large
The adb output is too big to send back (`ran: true`, so it ran). Write it to a file on the phone, then
pull the file, or ask for less output.

## phone_conflict
The phone is in the wrong state for this step, or another step holds it. With a `fix`, read the phone,
then do the step that fits its state. For adb, wait for the first command to finish, then retry.
With `reason: "duplicate"`, GitHub has two codespaces for this phone: give the user `user_url` to delete
the extra one. Do not retry before that.

## phone_not_ready
The phone is not running with Android ready. `fix` depends on `state`: a stopped phone needs a start,
then a wait. A starting or booting phone only needs a wait: do not start it again.

## rate_limited
Too many requests. Wait `retry_after` seconds. To wait for a phone, use
`GET /v1/phones/<id>?wait_for=ready` instead of starting it again.

## request_failed
Something failed on the way. Retry once after `retry_after`. With `ran: "unknown"` (adb), check the
screen first instead. If it fails again, tell the user and give them the `report` link.

## runner_update_required
The phone runs an old Emuly runner. Follow `fix` (update it, and repeat until `ready`). If that fails,
follow `if_fix_fails` (stop the phone; the next start gets the new runner).

## slow_down
Device sign-in: you polled too fast. Add 5 s to `interval` and keep polling.

## staging_full
The upload area is full. Wait for other uploads to finish, or cancel old ones.

## storage_full
The phone has no free storage. Ask the user before you delete apps or files.

## timeout
The phone did not answer in time, often just after boot. Wait `retry_after`, then send the same request.

## ui_unavailable
The phone could not read its screen layout now. Wait a second and retry, or use a screenshot.

## unauthorized
The key or session is missing or not valid. `reason` says which. Sign in again with the device sign-in (`fix`).

## unavailable
A short outage, for example a GitHub token refresh. Wait `retry_after`, then retry.

## upload_too_large
The body is too big for this route. For an APK, use `POST /v1/phones/<id>/app-installs`, or the CLI.
