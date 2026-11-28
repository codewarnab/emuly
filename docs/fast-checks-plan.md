# Plan: fast tests, lint, build and CI

Status: all 5 phases built (local numbers below). CI numbers wait for the first push.

Why: agents run these checks many times per task. Every second of waiting is time the agent and the
user wait too. Goal: CI result in under 1 minute at p50 and under 2 minutes at p95. Local
`pnpm test` + `pnpm lint` in under 1 minute on a 2-core machine.

Rules that rank above speed:
- Never hide failures: no retries, no wider timeouts, no skipped tests.
- Never check less: lint rules and required checks only stay the same or grow.
- Measure before and after every change, from real runs.

## 1. What we measured (69 CI runs, 27 Nov 2026)

| Job | Waiting for a runner (p50) | Setup (p50) | Running (p50 / p95) | Total (p50) |
|---|---|---|---|---|
| test | 3 s | ~13 s | **73 s / 79 s** | 92 s |
| typecheck | 3 s | ~13 s | 6 s / 8 s | 27 s |
| shellcheck | 3 s | 2 s | 1 s | 6 s |

- A whole CI run takes about 1 min 45 s. The test step is almost all of it.
- Setup is `actions/setup-node` (7 s) + `pnpm/action-setup` (4 s, p95 11 s) + checkout (2 s). `pnpm install` is 2 s.
- Waiting is already 3 s, and a new commit already cancels the old run (`concurrency` in `.github/workflows/ci.yml`).
- Local, 2 cores: `pnpm test` takes **229 s of wall time but only 57 s of CPU**. Most of the time is waiting.
- `next build` (local): compile 4.9 s, TypeScript 8.5 s, static pages 1.4 s. The TypeScript check repeats `pnpm lint`.

### The real cause: 4 tests wait on real time

| Test | File | Waits | Why |
|---|---|---|---|
| the per-phone lease lets only one server instance change a phone… | `lib/phone/phone-mutations.test.ts` | 20 s | the full `USER_LOCK_WAIT_MS` (`lib/phone/phone-mutations.ts:45`) before "already in progress" |
| creation reserves its operation before machine lookup… | same | 20 s | same |
| overlapping start and stop requests cannot race… | same | 20 s | same |
| local receiver … aborts a stalled response after 10 seconds | `lib/webhooks/webhooks.test.ts` | 10 s | `AbortSignal.timeout(10_000)` in `lib/webhooks/webhook-outbox.ts:48` |

Together that's about 70 s. Every other test takes 1.2 s or less.

## 2. The phases

### Phase 1: stop the 4 tests waiting on real time (biggest win) — DONE

Done:
- `createPhoneService` takes `userLockWaitMs` (default `USER_LOCK_WAIT_MS` = 20 s). Phone tests pass 200 ms.
- `createWebhookOutbox` takes `timeoutMs` (default `WEBHOOK_TIMEOUT_MS` = 10 s). The stalled-receiver test passes 300 ms.
- Two tests check the defaults stay 20 s and 10 s.
- Found while measuring: `lib/phone/scheduler.test.ts` kept its process alive about 60 s after its tests ended.
  Cause: a real race in `lib/phone/scheduler.ts`. If `stop()` ran while a loop was mid-work, the loop then
  started a new sleep that nothing woke. `pause` now returns at once after stop. 62 s → 3 s for that file.
- `pnpm test` has `--test-timeout=5000`: any single test over 5 s fails. The slowest test is 1.3 s today.
  5 s was chosen over 2 s, so a busy machine does not fail a test by chance.
- Local result, 2 cores: `pnpm test` 229 s → 91 s wall (CPU about 69 s). The suite is now limited by CPU.
  Node runs (cores − 1) files at a time, so on 2 cores it runs 1 file at a time. A 16-core machine gets 15 by default.
- CI numbers: measure after the first push.


**ASK:** make the waits injectable (recommended) or use `node:test` mock timers.
- Injectable: `createPhoneService` takes `userLockWaitMs` (default `USER_LOCK_WAIT_MS`), and the webhook
  outbox takes `timeoutMs` (default 10 000). Tests pass about 50 to 200 ms. The production code and its
  defaults stay the same. The tests still really time out, just sooner.
- Mock timers: no production change, but `withLease` mixes database calls and timer ticks, so fake
  time is fragile.

Steps:
1. Add the options and pass short values in the 4 tests. Keep one test that checks the defaults are still 20 s and 10 s.
2. Add a check that fails any single test over 2 s (a `--test-timeout`-style budget, so a new real-time wait is caught).
3. Measure: local wall time and CI test step, before and after.

Expected: CI test step 73 s → about 10 to 15 s. Local `pnpm test` 229 s → about 30 s.

### Phase 2: TypeScript 7 (native) for the type check — DONE

Done:
- `typescript7` (an alias for `typescript@7.0.2`) is a dev dependency next to `typescript@5`.
- `pnpm lint` runs TypeScript 7. `pnpm lint:ts5` runs TypeScript 5 when you want to compare.
- `next build` still loads `typescript` 5.9.3, so every build and deploy is still checked by TypeScript 5.
  This is the side-by-side check, with no extra step.
- Same result: 0 errors on the repo for both. 3 planted errors (a wrong type, a missing export, an unknown
  name in a .tsx file) gave the same 3 errors, with the same lines and codes, in both.
- Gotcha: both packages have a `tsc` command, and `node_modules/.bin/tsc` is now TypeScript 7. Scripts call
  each one by its path.
- Local result, 2 cores: type check 16 s → 4.3 s cold, 1.1 s warm.


- TypeScript 7.0 (July 2026) is the Go port. It is about 8 to 12 times faster.
- It has no compiler API until 7.1, and `next build` uses that API. So keep TypeScript 5 for `next build`,
  and run the check with TypeScript 7 under a second package name.
- Steps: add TS 7 as a dev dependency next to TS 5. `pnpm lint` runs TS 7. Run both side by side for a week and list any
  error one finds that the other misses. Then switch.
- Edge cases: `next typegen` must still run first (for `RouteContext`, `LayoutProps`). The `next` TS plugin
  only matters in the editor. Check `allowImportingTsExtensions` and the `.mjs` files.

Expected: typecheck 6 s → under 1 s in CI. Locally it's much faster for agents.

### Phase 3: faster setup in CI — DONE (small)

Done: `pnpm install --frozen-lockfile --prefer-offline`. Little else is safe to gain with pnpm: the pnpm store
is already cached, and the runners don't ship Node 26, so `setup-node` stays. Expect about 1 to 3 s, not 10 s.


- **Decided (28 Nov 2026): keep pnpm** and cache better. bun was rejected: it changes too many files for about 6 s more.
  - bun: `oven-sh/setup-bun` is about 1 to 2 s, against 11 s for `setup-node` + `pnpm/action-setup`.
    `bun install` is fast, and Vercel supports it. But this changes the lockfile and the
    `packageManager` field, `AGENTS.md`, the self-host Docker file and the docs.
  - Keep pnpm and cache better: smaller gain, about 3 to 5 s.
- Either way, run `node` for the tests and the server (see "Not now").
- Use a blobless checkout (`filter: blob:none`) only if checkout grows. Today it takes 2 s.

Expected: setup ~13 s → ~3 s per job.

### Phase 4: the same check before push (local hook) — DONE

Done:
- `.githooks/pre-push` runs `pnpm lint` and `pnpm test`. `pnpm install` turns it on (`prepare` →
  `scripts/install-hooks.mjs`), and does nothing outside a git checkout (Vercel, Docker).
- A repo `core.hooksPath` hides hooks from a global `core.hooksPath`. So each repo hook first runs the global
  hook of the same name (`.githooks/run-global`). `.githooks/commit-msg` only does that.
- CI shellcheck now checks `.githooks/*` too.
- No pre-commit hook: lint is about 1 s now, so there is no need for staged-files-only tricks.
- Local result, 2 cores: the hook takes about 104 s. On 16 cores, expect much less (not measured).


- **Decided (28 Nov 2026): a plain `.githooks/pre-push`**, turned on by `git config core.hooksPath` from a pnpm `prepare` script. `hk` was rejected: a new tool every clone must install.
- Add a pre-push hook that runs lint + test, the
  same as CI. A hook, not a line in `AGENTS.md`, because agents skip steps.
- Pre-commit: only fast checks on staged files (the type check, and shellcheck on changed `.sh`).
- Budget: under 10 s for pre-commit. Pre-push takes as long as the full suite, about 30 s after Phase 1.

### Phase 5: budgets so it stays fast — DONE

Done: `timeout-minutes` is 2 for typecheck, 3 for test, 1 for shellcheck (was 10, 15, 5). Test got 3, not 2,
because GitHub runners have 2 cores (local test run: about 91 s, plus setup). A "10 slowest tests" step prints
after every test run, even when tests fail.


- Each CI job gets a `timeout-minutes` close to its budget (test 2, typecheck 1, shellcheck 1).
  A job over budget fails, and we fix the cause, never the limit.
- Print the 10 slowest tests in the CI log on every run.

## 3. Not now, and why

| Idea | Why not now |
|---|---|
| `node --test` → `bun test` | Bun's `node:test` mocks are incomplete. 107 test files use `node:test`. After Phase 1 the gain is small. |
| Blacksmith or other paid runners | Waiting is already 3 s. The repo is public, so GitHub runners cost nothing. |
| Shards, or running only the tests the diff reaches | Not needed when the whole suite takes about 15 s. Revisit if it grows past 30 s. |
| Skipping the TypeScript check in `next build` | Pushes go straight to `main`, so CI is not required before deploy. Skipping it would check less. Revisit with a merge queue or required checks. |
| eslint, prettier, esbuild, tsx, nodemon, ioredis, pg, mysql2, better-sqlite3, aws-sdk, sharp, dotenv → bun | Not used in this repo. It uses Next, `@libsql/client` and plain `node`. |
| Adding a linter or formatter (oxlint, `bun lint`, `bun fmt`) | Would check more, which is allowed, but it's new work, not a speed fix. A separate decision. |

## 4. Expected result

| | Before | After phases 1 to 3 |
|---|---|---|
| CI run (p50) | ~1 min 45 s | ~25 to 35 s |
| Test step | 73 s | ~10 to 15 s |
| Typecheck step | 6 s | under 1 s |
| Setup per job | ~13 s | ~3 s |
| Local test + lint (2 cores) | ~4 min | ~35 s |
| CI cost | $0 (public repo) | $0 |

One small PR per phase, each with before and after numbers from real runs.

## Sources

- [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [TypeScript 7.0 RC](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/)
- [InfoQ: TypeScript 7 released](https://infoq.com/news/2026/08/typescript-7-released/)
- [Bun Node.js compatibility](https://bun.sh/docs/runtime/nodejs-compat.md)
- [Bun: dates and times in tests](https://bun.com/docs/test/dates-times.md)
- [egg.js PR on Bun node:test mock gaps](https://github.com/eggjs/egg/pull/5843)
- [Blacksmith pricing](https://docs.blacksmith.sh/runners/pricing)
- [GitHub Actions runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)
