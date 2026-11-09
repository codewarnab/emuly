# Webhooks (M4)

Open `/app/settings/webhooks` to add an endpoint, choose events, copy its signing
secret once, roll the secret, test it, inspect the last 50 deliveries, or resend.
The API and settings screen share validation and ownership checks. See
`/app/settings/webhooks/docs` for the API contract and Node/Python verification snippets.

## Delivery contract

All domain events pass through `emitEvent` in `lib/events.ts`. Each event receives
one stable `evt_` ID. SQLite atomically fans it out to enabled endpoints subscribed
to that event. A test event targets only the chosen endpoint. A resend creates
a new delivery ID but preserves the event ID and exact JSON body.

The poller sends due deliveries even when their owner has no phones, or GitHub is
rate limited. Each request has a 10-second deadline including DNS. After the
initial failure, five retries wait 1 minute, 5 minutes, 30 minutes, 2 hours and
6 hours. The sixth failure marks the delivery failed. Polling can add up to
60 seconds to a scheduled retry. Only 2xx responses count as success.

After three days of only failures, the endpoint disables. This check runs even
when retries have already ended. A notice appears across the console and on
the Webhooks screen. Success resets the failure window. Re-enabling explicitly
resets it too. Disabled endpoints retain their pending deliveries.

Secrets use the existing AES-GCM helper. Lists and logs omit the secret and its
ciphertext. Rolling a secret immediately affects pending retries. Payloads use
an explicit field allowlist and redact credentials and URLs in messages.

DNS is checked at registration and on every attempt. Every answer must be public.
The socket connects to a checked address while retaining the original TLS server
name and Host header. Redirects are never followed. HTTP localhost is allowed
only when `EMULY_BASE_URL` itself has the hostname `localhost`.

## Existing lifecycle limits

The current phone control plane does not connect the emulator runner or adb.
GitHub `Available` therefore remains `booting`; it must not emit `phone.ready`.
That event is supported by subscriptions and delivery, and the state transition
emitter includes it for the eventual confirmed `running` transition.

The current delete UI remains unavailable. Reconciliation emits `phone.deleted`
when GitHub reports deletion; M4 does not add destructive phone controls.
GitHub does not distinguish an external manual stop from idle timeout in the
fields currently read. Those stops use `reason: "github"`. Stops requested through
Emuly preserve `user`, `hours_budget`, or `retention` until shutdown confirms.

No real GitHub calls are required for M4 tests. The localhost receiver verifies
actual raw HTTP signatures and proves that redirects are not followed. Other
delivery tests use fake DNS, fake transport, SQLite, and an injected clock.
