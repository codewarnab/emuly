# Delete a phone

Deleting is off by default. Try `DELETE /v1/phones/<id>` once. If the user turned on
**Let agents delete phones without asking**, it deletes and returns `settings_url`. Say
exactly:

> I deleted <name>. To require approval again, turn off 'Let agents delete phones without asking' at <settings_url>.

If it returns **403**, do not retry the DELETE. Create an approval request with
`POST /v1/phones/<id>/delete-requests`, show `approve_url` on one line, then poll
`GET /v1/phones/<id>/delete-requests/<request_id>` every `interval` seconds. The approval
page is session-only; the agent can poll but never approve. When the switch is off,
mention once that it exists at **Settings › Agents**.

The request and its link last 10 minutes. `pending` means keep polling, `approved` means
the browser is deleting, `done` means the phone and its codespace are gone, `denied` means
the user kept it, and `expired` means ask again.

## Errors, settings and webhooks

- If a request fails with a network error, report the exact URL and the error text to the
  user. Do not retry more than twice without saying so.
- Any **403** body may include `manage_url`. Give the user that absolute link and say what
  to do on that page. Do not try to work around a 403, and never ask for a session cookie.
- Read settings with `GET /v1/settings` (no secrets) and one webhook with
  `GET /v1/webhooks/<id>` (never includes its signing secret). Both are read-only.
- Webhooks are optional. To get push notifications instead of polling, register one with
  `POST /v1/webhooks` and body `{"url":"https://example.com/emuly","events":"*"}`. List them
  with `GET /v1/webhooks`. An agent key cannot edit, test or delete webhooks.
