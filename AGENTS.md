<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Emuly

Emuly runs Android phones (emulators) in each user's own GitHub Codespaces. People use them in the browser. Agents use them through the `/v1` API and the `emuly` CLI.

## Product rules

Judge every change by these rules, in this order:

1. **Security.** Never trade security for speed or ease. Keep secrets encrypted, keys scoped and tickets short-lived.
2. **The user decides. The agent does the work.** Ask the user only for real decisions and approvals, such as deleting a phone. Agents do every other step.
3. **Minimal user effort.** Use good defaults and detect what you can, such as the region from the IP. Each extra click, field or setup step needs a strong reason.
4. **Speed.** Low latency is a feature. Count the network trips (browser → Vercel `bom1` → Turso → codespace) and remove the ones you can. Measure before and after.

## Where things are

| Path | What it holds |
|---|---|
| `app/(app)/app/` | Signed-in dashboard: phones, settings, events stream |
| `app/(marketing)/` | Public pages |
| `app/v1/` | Agent API (bearer key or session) |
| `app/actions/` | Server actions for the dashboard |
| `lib/phone/` | Phone logic. Start with `phone-mutations.ts` (create, start, stop), `phones.ts` (reads), `phone-agent-api.ts` (`/v1` handlers) |
| `lib/github/github.ts` | GitHub Codespaces API client |
| `lib/data/` | Database: `migrations.ts` (schema), `async-db.ts` (client), `database.ts` (local SQLite) |
| `lib/auth/` | Sessions, agent keys, token encryption |
| `lib/api.ts` | Wires route handlers to their dependencies |
| `phone/runner/` | Node server that runs inside each codespace (adb, scrcpy video, links) |
| `phone/scripts/` | Codespace boot and prebuild shell scripts |
| `bin/emuly.mjs` | The `emuly` CLI. `bin/server.mjs` is the Node server entry |
| `content/skills/emuly-playbook/` | The skill that agents install to drive phones |
| `deploy/selfhost/` | Docker self-host |
| `docs/` | Guides and plans |

## Commands

Use pnpm. The dev server is on http://localhost:4321.

```sh
pnpm dev        # local SQLite migrations, then the server
pnpm lint       # TypeScript 7 type check (about 1 s). pnpm build still checks with TypeScript 5
pnpm test       # node --test, lib/**/*.test.ts
pnpm build
```

Run one test file: `node --expose-gc --conditions=react-server --test --experimental-strip-types lib/phone/phones.test.ts`

## Rules

- Before you push, run `pnpm lint`, `pnpm test` and `pnpm build`.
- Production is Vercel `bom1` with a Turso database in `aws-ap-south-1`. Pushes to `main` deploy.
- **Schema:** add a new entry at the end of `MIGRATIONS` in `lib/data/migrations.ts`. Never edit an old entry.
- **Migrate production before you push** code that reads a new column. Vercel does not run migrations. Use the Turso CLI:
  ```sh
  echo libsql://emuly-codewarnab.aws-ap-south-1.turso.io > url.txt
  turso db tokens create emuly --expiration 1d > token.txt
  node --experimental-strip-types scripts/migrate-database.ts url.txt token.txt
  ```
  Delete both files after. Check with `turso db shell emuly "SELECT max(version) FROM schema_migrations"`.
- Foreign keys can be off on a Turso connection. Code that deletes rows must delete child rows itself (see `lib/data/purge-deleted-phones.ts`). Phones are soft-deleted (`state = 'deleted'`).
- Files that `node --test` loads must use relative imports with `.ts` extensions. The `@/` alias works only in Next.
- **Runner:** when you change `phone/runner/`, raise `RUNNER_VERSION` in `lib/phone/phone-setup.ts` to match the version in `runner.mjs`.
- **Skill:** when you change `content/skills/` or `content/agent/`, raise `AGENT_RUNBOOK_VERSION` in `lib/agent-runbook.ts`.
- Never log tokens, secrets, OAuth codes or user IPs. Encrypt new secret columns with `seal` from `lib/auth/crypto.ts` and add them to `lib/auth/reencrypt.ts`.
- Ask GitHub for no OAuth scope beyond `codespace`.
