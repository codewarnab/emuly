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

Limits: 200 MB total upload, 100 MB per pull or bugreport. A `@fileN` that was not uploaded,
or an uploaded file that args never references, is rejected before adb runs.

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

If an APK endpoint returns `503` with `runner_update_required`, the phone runner is old:
ask the user to open the phone in the browser and retry. `POST /v1/phones/<id>/apps/update`
also exists for that case.

Read the inventory with `GET /v1/phones/<id>/apps`. Open an app with
`POST /v1/phones/<id>/apps/open` and body `{"packageId":"com.example.app"}`.
