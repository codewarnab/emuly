# Emuly

Run a real Android emulator in the cloud, for free, inside your own GitHub Codespace.

Emuly starts an Android emulator in a codespace on your GitHub account. It uses the
Codespaces hours that your GitHub plan already includes (about 30 h/month on Free and
45 h/month on Pro, at 4 cores). Emuly bills nothing.

The main way in is through your coding agent. Copy one prompt into Claude Code, Codex,
Cursor, T3 Code or OpenCode. The agent does the setup and asks you only for approvals,
such as the GitHub sign-in. You can also watch and touch the phone in the browser.

## How it works

1. You sign in with GitHub. Emuly asks only for the `codespace` scope.
2. Emuly creates a codespace from this repository with `.devcontainer/phone/devcontainer.json`.
3. Emuly installs the emulator and the runner from `phone/` over the codespace tunnel.
4. Your agent or your browser controls the phone through the Emuly API.
5. GitHub stops an idle phone after 30 minutes or 4 hours. Stopping keeps the phone.

Only deleting the codespace erases the phone. Each phone uses one codespace, so more
phones share the same monthly hours.

## Run it locally

You need Node 26 and pnpm.

```sh
pnpm install
cp .env.example .env.local   # set the OAuth client and EMULY_TOKEN_KEY
pnpm db:migrate              # apply the database schema
pnpm dev                     # http://localhost:4321
```

### Create a GitHub OAuth App

1. Open GitHub **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Set the callback URL to `http://localhost:4321/auth/callback`.
3. Turn on expiring user tokens. Keep the device flow off.
4. Copy the client ID and a new client secret into `.env.local`.

### Checks

```sh
pnpm lint    # tsc --noEmit
pnpm test    # node:test unit tests in lib/**/*.test.ts
pnpm build
```

## API

The session-authenticated API includes:

- `GET /v1/usage`: remaining phone hours and storage.
- `POST /v1/phones`: create a phone. The body `{ "machine": "<name>", "idle_timeout_min": 30 }` is optional.
- `POST /v1/webhooks`: register a webhook. See [webhook setup and signature verification](docs/WEBHOOKS.md).

GitHub refusals return HTTP 409 with `{ "error": "github_refused", "message": "<GitHub message>" }`.
Each account can create one phone per minute and send six changes per minute.

## Security

- The OAuth App asks for `codespace` only. It never asks for `repo`.
- GitHub tokens, webhook secrets and runner secrets use AES-256-GCM. Each value is bound to its row.
- Agent sign-in endpoints have a rate limit per client IP.
- Every response sends security headers, such as `frame-ancestors 'none'` and HSTS.

To report a security problem, open a private
[security advisory](https://github.com/codewarnab/emuly/security/advisories/new). Do not open a public issue.

### Key rotation

1. Set `EMULY_TOKEN_KEY` to a new key and `EMULY_TOKEN_KEY_OLD` to the previous key. Deploy.
2. Run `pnpm db:rotate-key`. It encrypts each old value again with the new key.
3. When it reports 0 failures, remove `EMULY_TOKEN_KEY_OLD` and deploy again.

Users do not see a change. They stay signed in.

## Fair use

- Bring your own Codespace. Emuly never resells GitHub access.
- Use one GitHub account per person. Do not pool free accounts. See the
  [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service).

## Project layout

```
app/
  (marketing)/      landing page
  login/            sign-in page
  (app)/app/        console: dashboard, phones/[id]
  auth/             OAuth start, callback and logout routes
  v1/               public API
components/         phone, settings, ui, shell and marketing components
lib/
  phone/            lifecycle, setup, runner link, stream, apps, poller
  auth/             sessions, cookies, crypto, GitHub OAuth, key rotation
  github/           API client, tokens, billing, codespace tunnel
  data/             database, migrations, events, settings, usage, rate limits
  webhooks/         fan-out, signing, outbox, delivery API
  diagnostics/      startup reports
  shared/           display settings, hours, idle, keyboard, formatting
phone/              emulator runner installed in the codespace
deploy/vm/          scheduler deployment guide
docs/               webhook, billing and diagnostics docs
proxy.ts            protects /app/* (Next.js 16 replacement for middleware)
```

## Keyboard

`⌘K` / `Ctrl K` command menu · `?` shortcuts · `g p` phones · `g 1`…`g 9` open a phone ·
`1`–`4` phone tabs · `c` copy stream URL · `t` toggle dark mode. Delete has no shortcut.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
