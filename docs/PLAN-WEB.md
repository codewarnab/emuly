# phonelink web app — implementation plan

Status: draft, 2026-11-06. Design board: `design/console-v1.html`.
Scope: turn the Next.js landing page into a working product where **anyone signs in with
GitHub and drives an Android phone that runs in their own Codespace**. Build and test it
locally first; hosting is not part of this plan.

---

## 0. Summary in one paragraph

The web app is a thin, honest control panel over the user's own GitHub account. We never
host compute, never take a repo scope, and never bill. Each user authorizes a GitHub OAuth
app with the single `codespace` scope; we create a codespace from our public template repo,
install a tiny runner inside it that drives an AVD through the `android-emu` scripts, and
proxy the screen back through our own origin so the user never leaves the app.

Two hard constraints shape everything:

1. **Running phones share your hours.** See `PLAN-MULTI.md` §1: one phone per codespace by default; GitHub applies its own codespace limits.
2. **One destructive action.** Stopping keeps the phone; only deleting the codespace erases
   it. That asymmetry is the product's promise and must be enforced in code, not just copy.

---

## 1. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Framework | Next.js 16 App Router, TypeScript, RSC + Server Actions | Already scaffolded; landing page ported and verified pixel-identical |
| Styling | CSS Modules + shared tokens in `app/globals.css` — no Tailwind, no UI kit | Fidelity with the landing page; zero runtime deps |
| Auth | GitHub **OAuth App**, `scope=codespace`, our own DB session cookie | No password, no third-party auth service, scope is exactly the promise |
| Session | 32-byte random id stored in SQLite, HttpOnly `__Host-` cookie | Revocable server-side; no JWT to leak |
| Token at rest | AES-256-GCM, key from env, never logged | The token can touch all of the user's codespaces |
| Database | SQLite (`node:sqlite`, fallback `better-sqlite3`), WAL mode | Single VM, low write volume, no extra service |
| Validation | `zod` on every action input | One dependency, worth it at the trust boundary |
| Run | `pnpm dev` on `http://localhost:4321`, local only | You test locally first; hosting is a separate decision, out of scope here |
| Compute | User's own Codespaces quota | Never resell GitHub |

### Non-goals for v1

- No chat box. The agent lives in the user's terminal or IDE.
- No settings page. Machine type and idle timeout are chosen at create, then shown read-only.
- No billing UI. The quota meter links to GitHub.
- No team/org accounts. Personal accounts only (`GET /user`).
- No custom APK upload > 25 MB in v1 (install-by-URL only).
- No deployment. No Tailscale, Funnel, Caddy, domain, systemd, or public URL in this plan.

---

## 2. What already exists

```
/home/ubuntu/code/phonelink
  app/
    layout.tsx              root layout, metadata
    page.tsx                landing page (server component)
    landing.module.css      scoped port of site/index.html
    globals.css             tokens + reset, shared with the console
    rotating-word.tsx       client leaf (hero word rotation)
    scroll-button.tsx       client leaf (smooth scroll)
  design/console-v1.html    approved UI direction
  docs/                     conversation, keep-plan, this plan
  site/index.html           legacy static page (keep until launch)
```

Verified: `pnpm build` clean, `/` prerenders static, and a pixel diff against the legacy
HTML showed only the tap-ripple animation frame.

---

## 3. Architecture

```
                     ┌─────────────────────────────┐
   browser  ─────▶  │  next dev  :4321            │
   (local only)     │  ├─ /            landing    │
                    │  ├─ /login       OAuth      │
                    │  ├─ /app         dashboard  │
                    │  ├─ /app/phones/[id]        │
                    │  └─ /api/proxy/*  relay     │
                    └──────────┬──────────────────┘
                               │ SQLite (WAL)
                               │ sessions, phones, events, backups
                               │
              ┌────────────────┴─────────────────┐
              │                                  │
     GitHub REST API                    SSH tunnel (per active phone)
     (user's OAuth token)               gh codespace ssh -L
              │                                  │
              ▼                                  ▼
     user's codespaces                 runner :8790 inside codespace
     create / start / stop / delete           │
                                              ▼
                                        AVD + adb + ws-scrcpy
                                        (android-emu skill scripts)
```

Why the tunnel instead of `app.github.dev`:

- One origin. Our cookie, our auth, no cross-site iframe or second login.
- Proven path: the current rig already reaches the emulator over an SSH tunnel.
- `app.github.dev` private-port auth for a server-side client is an unverified assumption;
  the tunnel is not.

Cost: one `ssh` process per open phone, ~5–15 MB RSS plus stream bandwidth. Cap concurrent
tunnels (start with 6) and close on idle > 10 min.

---

## 4. Data model

SQLite file at `/var/lib/phonelink/phonelink.db`, `PRAGMA journal_mode=WAL`,
`PRAGMA foreign_keys=ON`, `PRAGMA busy_timeout=5000`.

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  github_id     INTEGER NOT NULL UNIQUE,
  login         TEXT NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  token_cipher  BLOB NOT NULL,          -- iv || tag || ciphertext (AES-256-GCM)
  token_scopes  TEXT NOT NULL,          -- as returned by GitHub, for the trust screen
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  blocked       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,         -- 32 random bytes, base64url
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  ua_hash     TEXT,
  ip_hash     TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE phones (
  id                TEXT PRIMARY KEY,   -- "phone-7f2a", also the display name
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  codespace_name    TEXT NOT NULL UNIQUE,  -- "phonelink-7f2a-3kd9"
  codespace_id      TEXT,
  repo_full_name    TEXT NOT NULL,
  machine           TEXT NOT NULL,
  state             TEXT NOT NULL,      -- pending|booting|running|stopped|error|deleted
  state_detail      TEXT,
  created_at        TEXT NOT NULL,
  last_started_at   TEXT,
  last_stopped_at   TEXT,
  retention_at      TEXT,                -- GitHub deletes the codespace after this
  runner_secret     BLOB NOT NULL
);
CREATE INDEX phones_user ON phones(user_id);

CREATE TABLE events (
  id        INTEGER PRIMARY KEY,
  phone_id  TEXT REFERENCES phones(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL,
  ts        TEXT NOT NULL,
  kind      TEXT NOT NULL,              -- step|error|action
  message   TEXT NOT NULL,
  meta      TEXT                        -- JSON, redacted before insert
);
CREATE INDEX events_phone_ts ON events(phone_id, ts DESC);

CREATE TABLE backups (
  id           INTEGER PRIMARY KEY,
  phone_id     TEXT NOT NULL REFERENCES phones(id) ON DELETE CASCADE,
  generation   TEXT NOT NULL,           -- "gen-3"
  bytes        INTEGER,
  sha256       TEXT,
  created_at   TEXT NOT NULL,
  verified_at  TEXT
);

CREATE TABLE usage_snapshots (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  ts            TEXT NOT NULL,
  core_hours    REAL,
  storage_mb    REAL,
  source        TEXT                    -- "github" | "estimate"
);
```

Notes:

- `phones.id` is generated once and never changes; `codespace_name` is what GitHub knows.
- `state` is *our* state machine, not GitHub's. GitHub says `Available|Shutdown|Starting|
  Creating|Deleted|Failed`; we translate and add `booting` while the AVD comes up.
- `events` is the feed shown in the UI. Every write goes through `redact()` which strips
  anything matching `gh[opsu]_[A-Za-z0-9]{20,}` and any `runner_secret`.

---

## 5. Auth flow

```
GET /login
  → 302 github.com/login/oauth/authorize
        client_id=...
        scope=codespace
        state=<random 16B, stored in signed 10-min cookie>
        allow_signup=true
  ← 302 /auth/callback?code=...&state=...
      verify state
      POST github.com/login/oauth/access_token   (client_secret, code)
      GET  api.github.com/user                   (id, login, avatar)
      GET  api.github.com/user/codespaces?per_page=1   ← scope probe, proves codespace access
      upsert user, encrypt token
      insert session, set cookie
  → 302 /app
```

Details that matter:

- **State cookie** is `__Host-pl_state`, `HttpOnly`, `Secure`, `SameSite=Lax`, 10-minute TTL,
  single use.
- **Cookies on localhost:** browsers treat `http://localhost` as a secure context, so
  `Secure` and `__Host-` cookies work without TLS. This stops working the moment you open
  the app on `http://<lan-ip>:4321`. Keep testing on `localhost`, or set
  `PHONELINK_COOKIE_INSECURE=1` for a plain-HTTP LAN test; the flag must be off before any
  real hosting.
- **No PKCE.** GitHub OAuth Apps support it only recently and the client secret is required
  anyway; the code is exchanged server-to-server.
- **Scope check:** if the returned `scope` does not contain `codespace`, we show a blocking
  screen explaining what to grant, with a retry link. We never ask for `repo`.
- **Revocation:** `/app/settings` is out of scope, but the login screen and the user menu
  link to `https://github.com/settings/applications` so revoking is one click.
- **Logout** deletes the session row and clears the cookie. It does *not* stop phones.

---

## 6. Control plane — GitHub REST calls

All calls use the user's decrypted token. Every function goes through one module,
`lib/github.ts`, which takes `(userId)` and never accepts a raw token from a request.

| Operation | Call |
|---|---|
| list our codespaces | `GET /user/codespaces?per_page=100` (filter by name prefix + DB) |
| available machines | `GET /user/codespaces/machines` |
| create | `POST /user/codespaces` `{ repository_id, machine, devcontainer_path, idle_timeout_minutes, retention_period_minutes }` |
| start | `POST /user/codespaces/{name}/start` |
| stop | `POST /user/codespaces/{name}/stop` |
| delete | `DELETE /user/codespaces/{name}` |
| state | `GET /user/codespaces/{name}` |

Rules:

- Machine type is **not hardcoded**. We ask GitHub what the user's plan allows and prefer
  `standardLinux32gb` (4 vCPU / 16 GB — the measured rig); fall back to the largest
  available and say so in the UI ("4 vCPU" vs "2 vCPU — boots slower").
- Per `PLAN-MULTI.md`, choose `idle_timeout_minutes: 30` (default) or `240` (4 h),
  and `retention_period_minutes: 43200` (30 days) for new phones.
- Every write is preceded by `assertOwnedCodespace(userId, name)`.

---

## 7. Safety invariants (the part that can ruin someone's week)

The token can manage **every** codespace the user owns. These invariants are enforced in
`lib/github.ts` and covered by tests:

1. `listCodespaces()` returns only codespaces whose name starts with `phonelink-` **and**
   whose name exists in our `phones` table for that user. Everything else is dropped before
   it reaches a page.
2. `start/stop/delete` call `assertOwnedCodespace()` first: the name must exist in `phones`
   for that `user_id`. A name from a form is never passed through.
3. No endpoint accepts a codespace name from the client. Routes use `phones.id` and resolve
   the name server-side.
4. Delete requires the server to compare a submitted confirmation string to `phones.id`.
   The client cannot delete by URL alone.
5. Every mutation writes an `events` row **before** the network call and one after, so a
   failure is visible and not silent.
6. Tokens are decrypted only inside `lib/github.ts` and `lib/proxy.ts`, never in a component.
7. Logging redacts: `gh[posu]_…`, cookie values, `Authorization` headers, and
   `runner_secret`.

---

## 8. The runner inside the codespace

The template repo (`phonelink-template`, public) has a devcontainer that:

- installs JDK 17, the Android command-line tools, an API 36 AVD, and `ws-scrcpy`;
- clones the public `agent-skills` repo for the `android-emu` scripts;
- runs `runner` on `127.0.0.1:8790`, started by `postStartCommand`.

Runner HTTP API (JSON, `X-Phone-Secret` header, secret generated per phone and stored
encrypted in `phones.runner_secret`):

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ ok, avd, api_level, booted }` |
| POST | `/boot` | `{ mode: "snapshot" \| "cold" }` | `{ booted, seconds }` |
| POST | `/stop` | — | `{ stopped, seconds }` |
| GET | `/screenshot` | — | `image/png` |
| POST | `/tap` | `{ x, y }` | `{ ok }` |
| POST | `/swipe` | `{ x1, y1, x2, y2, ms }` | `{ ok }` |
| POST | `/text` | `{ text }` | `{ ok }` |
| POST | `/install` | `{ url, sha256? }` | `{ package }` |
| GET | `/apps` | — | `[{ package, version, installed_at }]` |
| POST | `/keep` | `{ name? }` | `{ generation, bytes, sha256 }` |
| GET | `/backups` | — | `[{ generation, bytes, sha256, created_at }]` |
| POST | `/restore` | `{ generation }` | `{ restored }` |
| GET | `/stream` | — | `{ ws_url }` (ws-scrcpy) |

The runner is a ~200-line Node script, not a framework. It shells out to the skill scripts;
`boot.sh` already prints `keep: elapsed=…`, which we parse rather than re-implement.

**Frame strategy for v1:** `/api/proxy/[id]/frame` returns a screenshot PNG polled at 2 fps.
ws-scrcpy is wired in Phase 6 behind the same `/stream` origin. This keeps v1 shippable and
means taps work even when video does not.

**Tunnel lifecycle:** `lib/tunnel.ts` spawns
`gh codespace ssh -c <name> -- -N -L 8790:127.0.0.1:8790` with `GITHUB_TOKEN` in the child
env only. One process per active phone, refcounted, killed after 10 idle minutes or on stop.

---

## 9. Routes and components

| Route | Type | Design block | Notes |
|---|---|---|---|
| `/` | static | — | existing landing page |
| `/login` | static | 01 | shows granted/not-granted scopes |
| `/auth/callback` | route handler | — | OAuth exchange |
| `/app` | RSC + actions | 02 | card per phone, quota strip |
| `/app/phones/[id]` | RSC | 03 | stage + tabs |
| `/app/phones/[id]?tab=apps\|backups\|danger` | RSC | 03/04 | tabs are query state, no client router |
| `/app/backups` | RSC | — | all generations across phones |
| `/app/usage` | RSC | — | monthly meter + event history |
| `/api/proxy/[id]/frame` | route handler | — | PNG passthrough, auth required |
| `/api/proxy/[id]/stream` | route handler | — | WebSocket upgrade, Phase 6 |
| `/api/proxy/[id]/input` | route handler | — | tap/swipe/text, CSRF-checked |

Component layout:

```
app/
  (marketing)/page.tsx            landing (move current page.tsx here)
  (app)/app/layout.tsx            topbar, quota chip, user menu
  (app)/app/page.tsx              dashboard
  (app)/app/phones/[id]/page.tsx  phone detail
  (app)/login/page.tsx
  components/
    phone-card.tsx  pill.tsx  topbar.tsx  stage.tsx  log-feed.tsx
    quota-strip.tsx  danger-panel.tsx  empty-state.tsx
  actions/
    phones.ts       create/start/stop/delete
    input.ts        tap/swipe/text
  lib/
    db.ts  github.ts  crypto.ts  session.ts  tunnel.ts  runner.ts  redact.ts  rate-limit.ts
```

Server Actions are the only mutation path. Each one: `requireUser()` → `zod` parse →
ownership check → rate limit → event row → GitHub call → `revalidatePath`.

---

## 10. Phases

Estimates assume one engineer, this machine, and no surprises. Cost column is real money
spent on Codespaces during the phase.

### Phase 0 — Spikes (3–5 h, ~$1)

The two assumptions that could invalidate the design:

1. **Can `scope=codespace` alone create a codespace from a public repo?**
   Create the public template repo, an OAuth app, get a token with only `codespace`,
   `POST /user/codespaces` with `repository_id`. If it 403s, fall back to: GitHub App with
   `codespaces: write` + "only select repositories" (better story, more setup), or ask for
   `repo` (rejected — it breaks the promise).
2. **Does `gh codespace ssh` work with an OAuth token in `GITHUB_TOKEN` for a third-party
   account?** Test with `sutanukaa`, then with a second account. If not, the tunnel needs a
   device-flow key per user (worse UX) — find out now, not in Phase 5.

Also in Phase 0: confirm machine types visible to a free (non-Pro) account and whether
`standardLinux32gb` is offered.

**Acceptance:** a codespace created with a codespace-only token, an `echo ok` run through
`gh cs ssh` with that token, and a written note in `docs/SPIKE-RESULTS.md`. Delete the test
codespace at the end.

### Phase 1 — App shell and design system (4–6 h, $0)

- Move the landing page to `app/(marketing)/page.tsx`; keep it byte-identical.
- Extract `components/` primitives from the design board: `Pill`, `Button`, `Card`, `Stage`,
  `Meta`, `Tabs`, `Topbar`, `QuotaStrip`, `EmptyState`, `DangerPanel`.
- `app/(app)/app/layout.tsx` with the top bar; mobile breakpoints from the board.
- Fake data only, behind `PHONELINK_MOCK=1`.

**Acceptance:** `/app` and `/app/phones/phone-7f2a` render from fixtures at 1440 and 390
px, matching the board within a pixel diff, and the landing page diff is unchanged.

### Phase 2 — Database, sessions, OAuth (6–8 h, $0)

- `lib/db.ts` with migrations run at boot, WAL, prepared statements.
- `lib/crypto.ts`: AES-256-GCM seal/open, key rotation hook (`key_id` prefix).
- `lib/session.ts`: create, read, destroy, sliding 30-day expiry, `__Host-` cookie.
- `/login`, `/auth/callback`, `/logout`, blocked-scope screen.
- `requireUser()` used by everything under `/app`.

**Acceptance:** sign in with a second GitHub account, see the dashboard empty state, reload
and stay signed in, log out and be bounced from `/app` to `/login`. Token decrypts after a
process restart (key from env, not memory).

### Phase 3 — Read-only dashboard with real data (6–8 h, ~$1)

- `lib/github.ts` read paths: list, get, machines.
- State sync: on page load, plus a 30 s background sweep in `instrumentation.ts`.
- Quota: `GET /users/{login}/settings/billing/usage` is not available to OAuth Apps without
  `user` scope — so **estimate** from our own `events` + codespace `created_at`/`stopped_at`,
  label it "estimated" in the UI, and link to GitHub for the real number.
- Map GitHub states to our `Pill` states, including `needs you` with one fix sentence.

**Acceptance:** the two phones from `sutanukaa` appear with live state and uptime; a
codespace stopped outside the app shows as `stopped` within 30 s.

### Phase 4 — Mutations: create, start, stop (8–10 h, ~$2)

- Create: pick repo + machine, `idle_timeout_minutes`, `retention_period_minutes`; insert
  `phones` row with `state=pending`; drive the log feed from real events.
- Per `PLAN-MULTI.md` §1, no product phone count limit; an optional global operator cap protects local tests.
- Start: idempotent; polls until `Available`; then boots the AVD via the runner (or shows
  "boot first time: 60–160 s").
- Stop: the two-step grace — `POST /stop` on the runner, then GitHub stop. Never the reverse.
- Rate limit: 1 create/min/account, 6 mutations/min/account.

**Acceptance:** create → phone appears → open → stop → wake → the same app and data are
still installed (snapshot resume), proven by screenshot before and after.

### Phase 5 — The phone itself (10–14 h, ~$3)

- Deploy the template runner, secret provisioning at create.
- `lib/tunnel.ts` + refcounting + idle reap.
- `/api/proxy/[id]/frame` (2 fps PNG), `/input` (tap, swipe, text), CSRF token.
- Stage UI: tap-to-coordinate mapping (letterbox-aware), control row, take-over toggle.
- Event feed wired to real runner calls.

**Acceptance:** on a phone at 390 px wide, tapping a button in the app hits the right pixel
on the AVD (verified by screenshot diff), typing lands as text, and the stream dies cleanly
when the codespace stops.

### Phase 6 — Backups, streaming, usage (8–10 h, ~$1)

- Backups tab: list generations from `keep.sh`, size + hash verified badge, restore with a
  typed confirmation.
- ws-scrcpy behind `/api/proxy/[id]/stream`, opt-in per user, falls back to 2 fps.
- Usage page: monthly estimate, per-phone hours, retention countdowns.
- Danger tab: delete with typed phone id; deletes codespace + phone row, keeps events
  anonymised for rate-limit accounting.

**Acceptance:** restore a named generation and prove the app state rolled back; delete a
test phone and confirm the codespace is gone from GitHub.

### Phase 7 — Harden for local testing (6–8 h, $0)

- Rate limits, global concurrency guard, 429 page.
- `instrumentation.ts` sweeper: session expiry, tunnel reap, stale-state repair, retention
  warnings 24 h before GitHub deletes.
- Structured logs to stdout with redaction tests.
- `docs/RUNBOOK.md`: what to do when a phone is stuck, how to revoke everyone, how to rotate
  the encryption key.
- Accessibility pass: focus states, labels on the control row, contrast on `dim2` text.

**Acceptance:** a second GitHub account, different from the one in `gh`, signs in on
`localhost:4321`, creates a phone, uses it, stops it, and comes back to the same phone with
the app still installed.

**Total: 51–69 h**, ~$8 in Codespaces.

---

## 11. Local development only

There is no deployment step in this plan. No Tailscale, no Funnel, no Caddy, no systemd
unit, no public URL. The app runs on this machine so you can test it. Hosting is a separate
decision that happens later, and only after you say so.

```bash
cd /home/ubuntu/code/phonelink
cp .env.example .env.local        # gitignored, chmod 600
pnpm dev                          # http://localhost:4321
```

`.env.local` for local runs:

```
PHONELINK_BASE_URL=http://localhost:4321
PHONELINK_GITHUB_CLIENT_ID=…
PHONELINK_GITHUB_CLIENT_SECRET=…
PHONELINK_TOKEN_KEY=<32 bytes base64, generate with: openssl rand -base64 32>
PHONELINK_DB=.data/phonelink.db
PHONELINK_TEMPLATE_REPO=codewarnab/phonelink-template
# Optional operator cap across all users for local tests; unset by default.
# PHONELINK_MAX_PHONES=10
PHONELINK_MAX_TUNNELS=6
```

- GitHub OAuth App callback URL: `http://localhost:4321/auth/callback`. GitHub accepts
  `http://localhost` callbacks for local development.
- SQLite file lives in `.data/` inside the repo, already covered by `.gitignore`.
- Logs go to the terminal. No journald.
- Nothing listens on a public interface. The `dev` script passes `-H 127.0.0.1`, because
  Next.js otherwise binds every interface.

When you are done testing, `Ctrl-C` stops it. Nothing is left running.

Hosting notes, when you ask for them later, are one env var plus a reverse proxy. That work
is deliberately not in this document.

---

## 12. Copy rules for the app (enforced in review)

The landing page earned its trust by being accurate. The app keeps the same standard:

1. Never say we "keep", "save", or "wipe" anything — GitHub does. Say "your codespace keeps
   the phone" / "deleting the codespace erases it".
2. Never show a countdown we do not control. Retention is GitHub's clock; label it "GitHub
   deletes this on…".
3. The hours meter is an estimate and says so.
4. "Boot" numbers are ranges, not promises: 15 s resume, 60–160 s cold.
5. No "free plan" framing anywhere — there is one plan, and compute is the user's.

---

## 13. Testing

- **Unit (vitest):** crypto round-trip, redaction, state mapping, rate limiter, ownership
  assertions (the important one: a name not in `phones` must throw for every verb).
- **Integration:** SQLite migrations on a temp file; OAuth callback with a stubbed GitHub.
- **Contract:** recorded GitHub API fixtures for list/create/start/stop/delete.
- **Manual, per phase:** the acceptance line above, plus one screenshot diff for any UI
  change so the landing page never drifts.
- **Security checklist before launch:** no token in logs, no token in client bundles
  (`grep -r "gho_" .next`), cookie flags, CSRF on all POSTs, SSRF guard on `/install` URLs
  (https + size cap).

---

## 14. Risks and open questions

| Risk | Impact | Mitigation |
|---|---|---|
| `codespace`-only token cannot create from a public repo | Blocks the whole model | Phase 0 spike; fallback to GitHub App with per-repo install |
| `gh cs ssh` needs an interactive key | Blocks the tunnel | Phase 0 spike; fallback to `app.github.dev` port proxy with token auth |
| Codespace port forwarding auth for server clients | Phase 5 delay | Tunnel is the primary path for exactly this reason |
| Free accounts lack 4-core machines | Slower boots, worse UX | Query machines per user and show the real spec |
| Users hit quota mid-session | Phone dies confusingly | Pre-flight estimate + "needs you" state with a link to GitHub |
| Abuse: signups creating phones in a loop | Noise, support | 1 create/min, optional operator cap, GitHub limits, block list |
| OAuth callback host changes later | Sign-in breaks until the callback URL is updated | `PHONELINK_BASE_URL` is one env var; localhost now, whatever you pick later |

Open questions for the user:

1. Template repo owner/name — `codewarnab/phonelink-template`? (public)
2. Resolved in `PLAN-MULTI.md` §1: no product phone count limit; running phones share the account hours.

Hosting is not an open question here. It is out of scope until you finish local testing.

---

## 15. Definition of done for v1 (local)

You open `http://localhost:4321`, sign in with your own GitHub, create a phone, and get a
working Android screen in the browser. You can stop it, wake it, and the app you installed
is still there. You reach that point with no hand-edited database rows and no admin steps.

Public access is not part of this definition. It comes later, when you ask for it.
