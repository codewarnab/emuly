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
| Real phones: list, create, start, stop | next (PLAN-WEB Phases 3–4) |
| Many phones, hours budget, idle/retention care, webhooks | planned in `docs/PLAN-MULTI.md` |

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
  account per person). See `docs/PLAN-MULTI.md` §6.
- Agent-native: copy-prompt landing; the real instructions are the `android-emu` skill
  (https://github.com/codewarnab/agent-skills).
- Capacity: 1 phone per codespace by default; more phones means more codespaces sharing
  the same monthly hours.
- Stopping is safe: the codespace keeps the phone. Only deleting the codespace erases it.
- Named backups (`keep.sh`) are opt-in; two generations kept by default.

## Keyboard

`⌘K` / `Ctrl K` command menu · `?` shortcuts · `g p` phones · `g 1` / `g 2` open a phone ·
`1`–`4` phone tabs · `c` copy stream URL · `t` toggle dark mode. Delete has no shortcut.

## Related

- Measurements: https://github.com/codewarnab/homelab-docs/issues/124
- Emulator rig skill: https://github.com/codewarnab/agent-skills (`android-emu`)
