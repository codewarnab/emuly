import Link from "next/link";
import s from "../../../../../../components/console.module.css";

const node = `import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, rawBody, header) {
  const m = /^t=(\\d+),v1=([a-f0-9]{64})$/.exec(header ?? "");
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  const expected = createHmac("sha256", secret)
    .update(m[1] + ".").update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(m[2], "hex"));
}
// rawBody is the original Buffer, before JSON parsing.
// verify(process.env.WEBHOOK_SECRET, rawBody, req.headers["phonelink-signature"])
`;
const python = `import hashlib, hmac, re, time
def verify(secret, raw_body, header):
    m = re.fullmatch(r"t=(\\d+),v1=([a-f0-9]{64})", header or "")
    if not m or abs(time.time() - int(m[1])) > 300:
        return False
    message = m[1].encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, m[2])
# raw_body is the original bytes, before JSON parsing.
# verify(os.environ["WEBHOOK_SECRET"], raw_body, headers["phonelink-signature"])
`;

export default function WebhookDocs() {
  return <main className={`${s.pagewrap} ${s.webhookDocs}`} id="main-content" tabIndex={-1}>
    <p><Link href="/app/settings/webhooks">Back to Webhooks</Link></p>
    <h1>Webhook deliveries</h1>
    <p>Register an HTTPS endpoint in Settings → Webhooks. Copy the signing secret when it appears. Store it privately.</p>
    <p>Each JSON event has <code>id</code>, <code>type</code>, <code>version: 1</code>, <code>created_at</code> and <code>data</code>.
      Phone data contains only its ID, Codespace name, state and machine. Payloads exclude credentials and stream URLs.</p>
    <p>Headers: <code>phonelink-signature: t=&lt;unix&gt;,v1=&lt;hex HMAC-SHA256&gt;</code>, <code>phonelink-event</code> and <code>phonelink-delivery</code>.
      The signature covers the timestamp, a dot, and the exact request body. Never verify re-encoded JSON.</p>
    <h2>Verify in Node</h2><pre><code>{node}</code></pre>
    <h2>Verify in Python</h2><pre><code>{python}</code></pre>
    <p>Reject failed signatures and timestamps outside five minutes. After verification, deduplicate using the JSON event <code>id</code>.
      Resends keep that event ID but have a new delivery ID. Process each event once, then return a 2xx response.</p>
    <p>The poller sends queued events every 60 seconds. A request times out after 10 seconds, including DNS lookup.
      After the initial failure, retries wait 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours. The sixth failure is final.
      Delivery is at least once. A crash after receipt can cause another delivery.</p>
    <p>Endpoints disable after three days of only failures. The console shows a notice. Fix the receiver and choose Re-enable.
      Rolling a secret immediately replaces it, including for queued deliveries.</p>
    <p>Only public HTTPS addresses are allowed. Every send checks all DNS answers and pins a checked address.
      Redirects fail. HTTP localhost works only when PHONELINK_BASE_URL itself uses localhost.</p>
    <h2>API</h2>
    <p>The API uses your phonelink session. Browser mutations must come from the same origin. Responses are never cached.</p>
    <pre><code>{`GET /v1/webhooks
POST /v1/webhooks { "url": "https://example.com/hook", "events": "*" }
PATCH /v1/webhooks/{id} { "url": "https://example.com/new", "events": ["phone.stopped"], "enabled": true }
PATCH /v1/webhooks/{id} { "roll_secret": true }
DELETE /v1/webhooks/{id}
POST /v1/webhooks/{id}/test
GET /v1/webhooks/{id}/deliveries
POST /v1/webhooks/{id}/deliveries/{deliveryId}/resend`}</code></pre>
    <p>Create and roll return <code>secret</code> once. List and delivery responses never return secrets.
      Test queues only for the chosen endpoint, regardless of its event selection.</p>
  </main>;
}
