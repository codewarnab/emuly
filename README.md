# phonelink

Run an Android emulator in the cloud, for free.

phonelink runs a real Android emulator inside the user's own GitHub Codespace, on the
Codespaces hours their GitHub plan already includes (about 30 h/month on Free, 45 h/month
on Pro, at 4 cores). Nothing is billed by us. The main way in is agent-native: the user
copies one prompt into their coding agent (Claude Code, Codex, Cursor, T3 Code, OpenCode),
and the agent does the setup, asking the human only for approvals like the GitHub sign-in.
Watching and touching the phone in the browser is a bonus, not the headline.

## Status

| Area | State |
|---|---|
| Landing page (Next.js) | done: copy-prompt hero, agent logos, short FAQ |
| GitHub OAuth (`codespace` scope), encrypted tokens, sessions | done (Phase 2) |
| Console UI: dashboard, phone page, light/dark, ⌘K menu, shortcuts, toasts | done with example data |
| Codespaces: list, create, start, stop | M0 control plane implemented; runner boot, snapshot save and screen connection remain Phase 5 |
| Many phones, estimated hours budget, idle/retention care, webhooks | implemented per `docs/PLAN-MULTI.md`; tests use fake GitHub responses and clocks, plus a local webhook receiver. Real-account behavior remains unverified. |

Local only for now: no deployment, no public URL.

## Run it locally

Needs Node 26 and pnpm.

```sh
pnpm install
cp .env.example .env.local   # then fill in values (see below)
pnpm dev                     # http://localhost:4321
```

`.env.local` keys:

| Key | What |
|---|---|
| `PHONELINK_BASE_URL` | `http://localhost:4321` (use `localhost`, not `127.0.0.1`, or the OAuth state cookie is lost) |
| `PHONELINK_GITHUB_CLIENT_ID` / `PHONELINK_GITHUB_CLIENT_SECRET` | GitHub OAuth App, callback `http://localhost:4321/auth/callback`, expiring user tokens on, device flow off |
| `PHONELINK_TOKEN_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`), encrypts tokens at rest |
| `PHONELINK_DB` | SQLite path, e.g. `.data/phonelink.db` |
| `PHONELINK_MAX_TUNNELS` | relay guard, e.g. `6` (used from Phase 5) |
| `PHONELINK_MAX_PHONES` | Optional operator safety cap across all users for local tests (positive integer). Unset by default: no phonelink cap. GitHub still applies its own codespace limits. |
| `PHONELINK_TEMPLATE_REPO` | Optional. Leave unset to use this repository, `codewarnab/phonelink`, with `.devcontainer/phone/devcontainer.json`. It is private for now, so each user must be a collaborator to create a phone. phonelink installs the emulator and runner from `phone/` over the codespace tunnel (`lib/codespace-tunnel.ts`); the server needs no `gh` |
| `PHONELINK_TEMPLATE_REPOSITORY_ID` | Required only with `PHONELINK_TEMPLATE_REPO`: the numeric GitHub repository ID of that repository. Do not use a repository in the `github` org: it blocks OAuth apps |
| `PHONELINK_DEVCONTAINER_PATH` | Optional. Used only with `PHONELINK_TEMPLATE_REPO`; sent only when set |

M0 adds the New phone dialog and Wake/Stop actions, with ownership checks and recorded activity.
Creation uses 30-minute or 4-hour idle timeouts and 30-day retention. There is no product phone count limit.
Each account can create once per minute and request six mutations per minute, including failed requests.
SQLite upgrades existing databases to migration v2 on open. Stop waits for GitHub state reconciliation;
it does not claim that the runner saved a snapshot. Tests use fake GitHub HTTP and fake clocks.

The console shows remaining phone hours and storage from GitHub billing, when access is available.
Free includes 120 core-hours and 15 GB-month; Pro includes 180 core-hours and 20 GB-month.
The app reads the plan automatically. Existing saved allowances remain overrides.
Open **Override** to change the allowance or restore the automatic plan allowance.
Billing reports are cached per user for ten minutes. The countdown adds live phonelink usage.
Without billing access, the console labels usage **Estimate** and keeps login available.
**Connect billing for exact numbers** requests the optional OAuth `user` scope.
A refusal keeps the current session and estimate. The billing endpoint can still reject access.
[Billing implementation notes](docs/BILLING-USAGE.md) record the API assumptions and verification limits.
Runs count cores × elapsed hours in the UTC calendar month, including active runs and month boundaries.
A 60-second poller reconciles external starts/stops. The API and automatic stop still use the local estimate.
The dialog loads the account's available machines and respects stored machine/idle defaults.
More than six phones use a compact list by default. The view toggle is remembered per user in this browser.
“Stop all running” preserves every codespace and reports partial failures.

The session-authenticated API provides `GET /v1/usage` and `POST /v1/phones`.
Creation accepts JSON `{ "machine": "<available machine name>", "idle_timeout_min": 30 }`;
both fields are optional and use the user's defaults. GitHub refusals return HTTP 409
with `{ "error": "github_refused", "message": "<GitHub message>" }`. No billing API scope is required.

Running phones share your hours. GitHub stops an idle phone after 30 minutes or 4 hours,
your choice at create. Stopping keeps the phone. New phones have 30-day retention;
the console shows each stopped phone's countdown because existing phones can have shorter retention.
The copied agent prompt explains idle activity and optional webhook notifications through
`POST /v1/webhooks`. See [webhook setup and signature verification](docs/WEBHOOKS.md).

Checks:

```sh
pnpm lint    # tsc --noEmit
pnpm test    # node:test unit tests in lib/*.test.ts
pnpm build
```

## Layout

```
app/
  (marketing)/      landing page
  login/            sign-in page
  (app)/app/        console: dashboard, phones/[id]
  auth/             OAuth start, callback, logout routes
components/         UI (CSS Modules, no UI library), command menu, toasts, theme toggle
lib/                env, crypto (AES-256-GCM), SQLite (node:sqlite), sessions, GitHub OAuth
proxy.ts            protects /app/* (Next 16 replacement for middleware)
public/agents/      agent logos (from svgl.app)
docs/
  PLAN-WEB.md       main implementation plan (phases 0–7)
  PLAN-MULTI.md     many phones, hours budget, idle timeout, retention, webhooks
  DESIGN.md         design system and critique notes
  HANDOFF-PROMPT.md rules and product facts
  CONVERSATION.md   original design discussion and measurements
  PLAN-KEEP.md, PROBLEM-KEEP.md, SPIKE-RESULTS.md
preview/redesign/   screenshots of every screen, light and dark, 1440/1024/390
site/index.html     the original static landing page (historical)
```

## Decisions in one screen

- Bring your own Codespace. Never resell GitHub access.
- OAuth App with `scope=codespace` only. No `repo`, no device flow.
- One GitHub account per user; no pooling of free accounts (GitHub Terms allow one free
  account per person). See [GitHub Terms](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
  and `docs/PLAN-MULTI.md` §6.
- Agent-native: copy-prompt landing; the real instructions are the `android-emu` skill
  (https://github.com/codewarnab/agent-skills).
- Capacity: 1 phone per codespace by default; more phones means more codespaces sharing
  the same monthly hours.
- Stopping is safe: the codespace keeps the phone. Only deleting the codespace erases it.
- Named backups (`keep.sh`) are opt-in; two generations kept by default.

## Keyboard

`⌘K` / `Ctrl K` command menu · `?` shortcuts · `g p` phones · `g 1`…`g 9` open a phone ·
`1`–`4` phone tabs · `c` copy stream URL · `t` toggle dark mode. Delete has no shortcut.

## Related

- Measurements: https://github.com/codewarnab/homelab-docs/issues/124
- Emulator rig skill: https://github.com/codewarnab/agent-skills (`android-emu`)
