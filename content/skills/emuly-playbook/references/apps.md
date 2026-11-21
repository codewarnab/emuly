# Files, installs and downloads

Send files as `multipart/form-data`. The `args` field is the same JSON array, `timeout_s`
is optional, and `file0`, `file1`, … are the uploads. In args, `@file0` stands for the
first file. The runner picks a temporary path, uses it for one command, and deletes it.

- **Install:** `["install","-r","@file0"]` or `["install-multiple","-r","@file0","@file1"]`.
  The only install flags are `-r`, `-t`, `-g`, `-d` and `--abi`.
- **Push:** `["push","@file0","/sdcard/Download/x.txt"]`. The device path must be under
  `/sdcard/` or `/data/local/tmp/`, with no `..`.
- **Pull and bugreport:** `["pull","/sdcard/x.png"]` and `["bugreport"]` stream bytes with a
  `Content-Disposition` filename. Save them to a laptop path.

Limits: 4 MB of files on this route, 100 MB per pull or bugreport. A `@fileN` that was not
uploaded, or an uploaded file that args never references, is rejected before adb runs.

## Large files (over 4 MB, up to 1 GiB)

The `/adb` route cannot take more than 4 MB: the host refuses a larger body with an HTML page.
Check the file size first. For a larger `install`, `install-multiple` or `push`, use two steps:

1. `POST /v1/phones/<id>/adb/upload` with JSON
   `{"args":["push","@file0","/sdcard/Download/x.zip"],"files":[{"name":"x.zip","size":N,"sha256":"<hex>"}]}`.
   `size` is in bytes. `sha256` is the lowercase SHA-256 of the file. `timeout_s` is optional.
2. The answer has `url`, `method` and `headers`. Within 60 s, send `PUT <url>` with those
   headers and the bytes of file0, file1, … one after another as the body. Use
   `curl -X PUT -H "Authorization: …" -H "Content-Type: application/octet-stream" --data-binary @x.zip <url>`.

The answer is the usual `{exit_code, stdout, stderr}`. The ticket works once and only for those
args and files: for a retry, repeat step 1. `401 invalid_ticket` means the ticket expired or was
used. If step 1 returns `503 direct_upload_unavailable`, or the PUT cannot reach `app.github.dev`,
use the Apps endpoint below for an APK. That endpoint sends 4 MiB chunks.

## Download a public URL to the phone

The phone has no `curl` or `wget`. To put a public file on the phone, let the codespace
download it. The bytes do not pass through your machine or the 4 MB limit.

`POST /v1/phones/<id>/file-fetches` with JSON
`{"key":"<new uuid>","url":"https://...","dest":"/sdcard/Download/data.json"}`.
Optional: `"sha256":"<lowercase hex>"` (the push happens only if the file matches) and
`"overwrite":true` (without it, an existing `dest` is an error). The answer is `202` with an `id`.
Poll `GET /v1/phones/<id>/file-fetches/<id>` until `stage` is `done`, `failed` or `cancelled`.
The stages before that are `downloading`, `verifying` and `pushing`. A `done` fetch has `sha256`.
Stop a fetch with `POST /v1/phones/<id>/file-fetches/<id>/cancel` (not during `pushing`).

Rules:
- `url`: HTTPS on port 443, no `user:pass@`, no `#fragment`, at most 5 redirects. Every address
  must be public: localhost, private networks, link-local and cloud metadata addresses fail
  with `private_url`. No cookies or auth headers are sent, so a URL that needs a login fails.
- `dest`: a file path under `/sdcard/` or `/data/local/tmp/`, with only letters, digits,
  `.`, `_`, `-` and `/`. No `..`, and not a folder.
- Limits: 1 GiB, 10 minutes, one fetch at a time per phone, 6 starts a minute.
  A compressed (`Content-Encoding: gzip`) answer fails with `encoded_download`.
- A runner restart forgets fetches: `404 not_found` on a poll means start again with a new key.
- The same `key` with the same input returns the same fetch, so a retry is safe.

Error codes in `error_code`: `invalid_url`, `private_url`, `redirect_limit`, `download_failed`
(the message has the HTTP status), `too_large`, `encoded_download`, `timeout`,
`checksum_mismatch`, `dest_exists`, `storage_full`, `push_failed`, `operation_active`,
`rate_limit`. `503 runner_update_required` means an old runner: see below.

## Install an APK with the Apps endpoint (alternative)

`POST /v1/phones/<id>/app-installs` is better for large files, direct URLs and install
progress. Every operation needs a fresh UUID in `key`.

- **Direct HTTPS URL:** body `{"source":"url","key":"<uuid>","url":"https://..."}`. Then poll
  `GET /v1/phones/<id>/app-installs/<operation-id>`.
- **Local file:** body `{"source":"upload","key":"<uuid>","filename":"app.apk","totalBytes":N}`.
  Send 4 MiB chunks with `PUT /v1/phones/<id>/app-installs/<operation-id>/content`. Each chunk
  needs `content-type: application/octet-stream`, `x-upload-offset` and `x-chunk-sha256`
  (lowercase SHA-256 of that chunk). Finish with
  `POST /v1/phones/<id>/app-installs/<operation-id>/complete`.

Poll the operation until its `stage` is `succeeded`, `failed`, `cancelled` or `interrupted`.

The operation also has `serverUrls` after validation: local server URLs inside the APK, such as
`http://localhost:3000`. If it is not empty, follow `references/local-servers.md` before the
test. The adb `install` route does not scan the APK.

If an APK endpoint returns `503` with `runner_update_required`, the phone runner is old:
ask the user to open the phone in the browser and retry. `POST /v1/phones/<id>/apps/update`
also exists for that case.

Read the inventory with `GET /v1/phones/<id>/apps`. Open an app with
`POST /v1/phones/<id>/apps/open` and body `{"packageId":"com.example.app"}`.
