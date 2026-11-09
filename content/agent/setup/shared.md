# Get an Emuly key

First check for a saved key in the `EMULY_KEY` user variable. If one exists, skip this section.

The prompt either contains a setup code such as `emuly_sc_...` or it has no code:

- **Setup code in the prompt (A1):** exchange it once for a 90-day key with
  `POST /v1/agent/token` and body `{"code":"emuly_sc_...","name":"<agent> on <computer>"}`.
- **No setup code (A2):** start the device sign-in flow, show the user one short link, and
  wait for them to approve it in the browser.

Both return `key`, `expires_at`, `save`, `read` and `clear`. `save` is a command that stores
the key in the user variable `EMULY_KEY`. Run it once. Never print the key in the chat.

### A2. Device sign-in flow

Run `POST /v1/agent/device`. It returns `device_code`, `user_code`,
`verification_uri_complete`, `expires_in` and `interval`. Show only the
`verification_uri_complete` link, on one short line:

> Approve this sign-in: https://your-emuly-host/link?code=WXYZ-2345

Ask the user to open it and approve the code. Then poll
`POST /v1/agent/device/token` with `{"device_code":"..."}` every `interval` seconds
(10 minutes maximum). Keep the device code in a variable, never in the chat.

- `authorization_pending`: keep polling.
- `slow_down`: wait 5 extra seconds, then keep polling.
- `access_denied`: stop. The user denied it.
- `expired_token`: stop. Ask the user to click **Copy prompt** again.
- Success returns the same body as `/v1/agent/token`. Save the key once and never print it.

### Later sessions and 401

Each new shell reads `EMULY_KEY` again; it is the only setup a later session needs. Never
exchange a second setup code unless the user clicks **Copy prompt** again in the console.

If a request that uses the saved key returns **401**, the key is expired or revoked:

1. Clear the saved key (the `clear` command from the response).
2. Ask the user to click **Copy prompt** in the Emuly console and send you the new code.
3. Exchange the new code once. Do not reuse the old code.
