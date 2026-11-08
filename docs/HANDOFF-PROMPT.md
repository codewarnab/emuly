# Handoff brief — build the phonelink console

Copy the prompt at the bottom of this file, or open this folder and say:
"Read `docs/HANDOFF-PROMPT.md` and start at Step 1."

Everything below is verified fact as of 2026-11-06. Where a fact is unknown, it is marked
UNKNOWN. Do not guess an UNKNOWN value.

---

## 1. The job

Build the phonelink console: a Next.js app where a person signs in with their own GitHub
account and drives an Android phone that runs in their own Codespace.

The landing page already exists and is finished. Do not restyle it. The work is the console
behind it: login, dashboard, phone detail, actions, and the API relay.

Build order and detail live in `docs/PLAN-WEB.md`. That file is the source of truth. This
brief adds the facts that the plan assumes.

---

## 2. Where everything is

Project root: `/home/ubuntu/code/phonelink`

```
app/
  layout.tsx            root layout, metadata, viewport
  page.tsx              landing page, server component, FINISHED
  landing.module.css    scoped landing CSS, FINISHED
  globals.css           shared tokens: --bg --panel --line --text --dim --dim2 --accent
  rotating-word.tsx     client leaf, hero word rotation
  scroll-button.tsx     client leaf, smooth scroll
design/console-v1.html  APPROVED UI board (deleted; see docs/DESIGN.md)
docs/PLAN-WEB.md        implementation plan: schema, auth, phases, safety rules
docs/CONVERSATION.md    original design discussion and measurements
docs/DESIGN.md          design system, tokens and component inventory
site/index.html         legacy static landing page (deleted)
preview/*.png           landing renders at 1440 and 430 wide (deleted)
```

The UI board, the legacy landing HTML and the preview renders are no longer in the repo.
Read `docs/DESIGN.md` and `components/console.module.css` for the live visual system.

## 3. Verified environment

- Node v26.12.1, pnpm 12.8.1, aarch64 Linux.
- Next.js 16.4.5 (App Router, Turbopack), React 19.3.0, TypeScript 5.9.3.
- `next.config.ts` has `cacheComponents: true` and `partialPrefetching: true`.
- `package.json` scripts:
  - `dev`: `next dev -H 127.0.0.1 --port 4321`
  - `build`: `next build`
  - `start`: `next start -H 127.0.0.1 --port 4321`
  - `lint`: `tsc --noEmit`
- `pnpm build` passes. `/` prerenders as static.
- The landing page was pixel-verified against the legacy `site/index.html` during the
  port: 139 differing pixels in one 20×20 box at 1440 px, caused only by the looping
  tap-ripple animation frame. That baseline has since been deleted from the repo.

## 4. Non-negotiable rules

1. **Local only.** No deployment. No Tailscale, no Funnel, no Caddy, no systemd, no domain,
   no public URL. The app runs on `http://localhost:4321`. Hosting is a separate decision
   that the user makes later.
2. **Never use these GitHub accounts:** `codewarnab` (dev) and `arnab-naalandaai` (work).
   The active pool account is `sutanukaa`. `blacknut1803` is also logged in.
3. **Never delete a Codespace or an AVD without explicit, per-item confirmation from the
   user.** Stopping is always allowed. Stop order is `stop.sh`, then `gh codespace stop`.
4. **Only deletion wipes the phone.** Stopping keeps the disk and the snapshot. This must
   hold in code, not just in copy. No code path may delete as a side effect of stop, expiry,
   error handling, or cleanup.
5. **Free forever.** One plan. No "pro", no "coming soon", no waitlist. Compute comes from
   the user's own GitHub quota.
6. **One OAuth scope: `codespace`.** Never request `repo`, `user`, `admin:org`, or billing.
   If a feature needs more, stop and ask.
7. **The token can reach every codespace the user owns.** The app may only touch codespaces
   whose name starts with `phonelink-` **and** which exist in the `phones` table for that
   user. Enforce this in one module, and test it.
8. **Do not change the landing page copy or layout.** Its accuracy is the product's trust
   story. A pixel diff must stay clean.
9. **Never print, log, or commit secrets.** No tokens, no client secret, no cookie values.
   `.env.local` only, and it stays gitignored.
10. **Ask before spending real money.** Creating a codespace for a spike is fine and
    expected. Anything beyond a handful of test codespaces needs a yes.

## 5. Product facts you must not contradict

Measured on a 4 vCPU / 16 GB codespace, November 2026:

| Fact | Value |
|---|---|
| One phone cost | ~180% of 400% CPU, ~3 GB RAM |
| Three phones | saturate 98% of 4 vCPU; use one phone per codespace by default, two for light use |
| Snapshot resume | ~15 s |
| Cold boot | 63–157 s |
| Disk per phone | ~26 GB |
| Free plan hours | 30/month (120 core-hours ÷ 4 cores) |
| Pro plan hours | 45/month (180 core-hours ÷ 4 cores) |
| Retention after last stop | 30 days for new phones, set at create; show each phone's countdown |
| Idle stop | 30 minutes (default) or 4 hours, chosen at create |
| Machine type | query from GitHub, never hardcode. Prefer `standardLinux32gb` |
| Apps that work with it | T3 Code, Claude Code, Codex, OpenCode. Only these four |

Copy rules: never say we keep, save, or wipe anything. GitHub does. Say "your codespace
keeps the phone". Label the hours meter "estimated". Boot numbers are ranges.

## 6. Open question — do not guess

**Template repo name.** The plan assumes `codewarnab/phonelink-template` (public, holds the
devcontainer and the runner). This is UNKNOWN and unconfirmed. Ask the user before creating
anything that depends on it. Until then read it from
`PHONELINK_TEMPLATE_REPO` and fail loudly if unset.

Everything else needed for Phase 1 and Phase 2 does not depend on it.

## 7. Build order

Full detail is in `docs/PLAN-WEB.md` section 10. Summary:

| Phase | Work | Est. | Gate |
|---|---|---|---|
| 0 | Two spikes: codespace-only token creates a codespace; `gh cs ssh` works with that token | 3–5 h | Written result in `docs/SPIKE-RESULTS.md` |
| 1 | App shell and components from `docs/DESIGN.md`, mock data | 4–6 h | `/app` matches the documented measurements at 1440 and 390 px |
| 2 | SQLite, sessions, GitHub OAuth, `requireUser()` | 6–8 h | Second account signs in, reloads, logs out |
| 3 | Dashboard with real read-only GitHub data | 6–8 h | Live state within 30 s |
| 4 | Create, start, stop | 8–10 h | Stop then wake keeps installed apps |
| 5 | Phone screen: tunnel, screenshot, tap, text | 10–14 h | Tap lands on the right pixel |
| 6 | Backups, streaming, usage, delete | 8–10 h | Restore rolls back; delete removes the codespace |
| 7 | Harden, sweeper, runbook, a11y | 6–8 h | Full loop works on localhost |

Stop and report after Phase 0, after Phase 2, and after Phase 5. Continue through the
others without asking, unless a gate fails.

## 8. How to verify your own work

- `pnpm build` must pass and `pnpm lint` must be clean before you report.
- Landing page: screenshot `http://127.0.0.1:4321/` and check layout, theme and tap
  ripple by eye. The old pixel baseline is no longer in the repo.
- Screenshot tool available:
  `~/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell`
  with flags `--no-sandbox --hide-scrollbars --window-size=W,H --screenshot=path URL`.
- Console screens: compare against the tokens and measurements in `docs/DESIGN.md` at
  1440 and 390 px.
- Never claim a screen is correct from code alone. Look at the pixels.

## 9. How to report

- Short. First line is the state or the next action.
- Number multi-step work. Cap lists at 5 items.
- Give concrete time estimates.
- Make finished work visible: what now works, and how to see it.
- No preamble, no "let me know if you need anything".

## 10. Environment file shape

`.env.local`, gitignored, mode 600. Never paste values into chat.

```
PHONELINK_BASE_URL=http://localhost:4321
PHONELINK_GITHUB_CLIENT_ID=
PHONELINK_GITHUB_CLIENT_SECRET=
PHONELINK_TOKEN_KEY=      # openssl rand -base64 32
PHONELINK_DB=.data/phonelink.db
PHONELINK_TEMPLATE_REPO=
# Optional operator cap across all users for local tests; unset by default.
# PHONELINK_MAX_PHONES=10
PHONELINK_MAX_TUNNELS=6
```

OAuth App callback URL to register: `http://localhost:4321/auth/callback`.

---

## The prompt to paste

```
You are building the phonelink console in /home/ubuntu/code/phonelink.

First, read these files in this order, fully:
1. docs/HANDOFF-PROMPT.md   (the brief, rules, and facts)
2. docs/PLAN-WEB.md         (the implementation plan and phases)
3. docs/DESIGN.md           (the approved UI system, tokens and measurements)
4. app/page.tsx and app/globals.css (the finished landing page and its tokens)

Then start at Phase 0 of the plan.

Hard constraints, in priority order:
- Local only. Build and run on http://localhost:4321. No Tailscale, Funnel, Caddy,
  systemd, domain, or public URL. Do not propose hosting.
- Never use the GitHub accounts codewarnab or arnab-naalandaai. Use sutanukaa.
- Never delete a codespace or AVD without explicit confirmation from me, for that
  specific item. Stopping is always fine, and stopping must never wipe the phone.
- One OAuth scope only: codespace. Never ask for repo.
- Only touch codespaces named phonelink-* that exist in our own database for that user.
- Do not change the landing page. It is finished and verified.
- Free forever. One plan. No paid tier, no waitlist, no "coming soon".
- Never print or commit secrets. Use .env.local.

Do not guess these, ask me:
- The template repo name (PHONELINK_TEMPLATE_REPO).
- Anything that would delete data.
- Anything that spends meaningful Codespaces money beyond a few test codespaces.

Report after Phase 0, after Phase 2, and after Phase 5. Use short, numbered,
concrete updates with real time estimates. Show what now works, not what you intend.
```
