# Self-host

Run Emuly on your own machine or in one Docker container, with your GitHub account
instead of a hosted service. Everything the hosted deployment does stays the same:
phones still run in your own GitHub Codespaces on your plan's included hours.

## How it works

- One Node process runs the Next app, the backend and the phone stream proxy.
- The GitHub token does not live in Emuly. The `gh` CLI inside the same runtime
  holds it, and `gh auth token` hands it over at request time. gh ≥ 2.103
  refreshes an expiring token before printing it, so Emuly needs no refresh code.
- There is exactly one user: the account signed in to gh. No OAuth App, no client
  secret, no `.env.local`.
- The token encryption key is generated into `<database directory>/token.key` on
  first start, so webhook secrets still get AES-256-GCM at rest.
- `EMULY_SELF_HOST=1` turns the mode on. Unset (the default), Emuly behaves
  exactly like the hosted deployment.

## Option A: Docker (recommended)

You need Docker or Podman with Compose. From `deploy/selfhost/`:

```sh
docker compose build
docker compose run --rm emuly gh auth login -h github.com -s codespace
docker compose up
```

Log in before `docker compose up`: the container exits with login guidance
until the credential store exists, and `restart: unless-stopped` then restarts
it with backoff until you do. (Nothing is harmed by starting first — the app
simply waits for the login above.)

Then open `http://localhost:4321`. The login runs gh's device flow: GitHub shows a
one-time code, you enter it in the browser, and the credential store is written to
the `emuly-gh` volume — it survives restarts.

If the login reports the scope is missing, run:

```sh
docker compose run --rm emuly gh auth refresh -h github.com -s codespace
```

`docker compose run --rm emuly node bin/emuly.mjs doctor` checks gh, the token, the
codespace scope and the data directory in one go. Publish the port on loopback
only (the compose file already does): the self-host API is intentionally
unauthenticated and must not be reachable from other machines.

### Podman

Every command above works with `podman compose` in place of `docker compose`.

- `podman compose` needs a compose provider: `podman-compose` or `docker-compose`.
- On macOS and Windows, start the VM first: `podman machine init` (once), then `podman machine start`.
- Rootless Podman is fine. The port is still published on loopback, and the
  `emuly-data` and `emuly-gh` volumes work the same way.

## Option B: local, without Docker

You need Node 26, pnpm and the gh CLI, signed in on this machine.
A default `gh auth login` grants `repo`, `read:org` and `gist`, **not `codespace`**.
If you already use gh, grant the extra scope before starting:

```sh
gh auth refresh -h github.com -s codespace
```

Only gh's active account is used. Check it with `pnpm emuly doctor`, or switch
with `gh auth switch -h github.com`.

Then install and start:

```sh
pnpm install
pnpm emuly up
```

`up` checks gh, runs the database migration and starts the server with the flag
set. If it asks for a login or a scope repair, run the command it prints, or
`pnpm emuly login` and start again.

## The build-time flag

`EMULY_SELF_HOST=1` must be set when you build (`docker compose build` does this
through the Dockerfile). Bundles such as the proxy may inline environment values
at build time, so a runtime-only flag could leave self-host code compiled out.
The Dockerfile sets it in both stages, so the compose path needs no extra env
file. Builds and startup reject self-host on Vercel and production HTTPS base
URLs other than localhost. The local `--prod` path is different:
`pnpm emuly up --prod` serves the last build, so build with the flag set (`EMULY_SELF_HOST=1 pnpm build`) —
`emuly up --prod` warns when the flag is not set in the environment.

## Prebuilds and phone boot time

Keep the default template (`codewarnab/emuly`, now public) for fast boots:
Codespaces use its existing prebuild for `.devcontainer/phone/devcontainer.json`.
No setup is needed.

A fork selected with `EMULY_TEMPLATE_REPO` has no prebuild, so each new phone
performs a full cold boot. In the fork, open **Settings → Codespaces → Set up
prebuild**, choose the branch, `.devcontainer/phone/devcontainer.json`, and the
regions you use. Prebuild storage is billed to the fork owner. Set
`EMULY_TEMPLATE_REPOSITORY_ID` to the fork's matching repository ID and
`EMULY_DEVCONTAINER_PATH=.devcontainer/phone/devcontainer.json`.
Emulator and runner setup still runs after the Codespace becomes Available.

## Volumes and backups

| Volume        | Contents                                    |
| ------------- | ------------------------------------------- |
| `emuly-data`  | `emuly.db` (SQLite) and the `token.key` file |
| `emuly-gh`    | gh's credential store (the GitHub token)     |

Both are ordinary Docker volumes. A backup of the data volume is a tarball
made with the app **stopped** — the database runs in WAL mode, so a tar of a
live container can miss committed WAL contents, and a restore must never
extract under a live connection. The one-off `run` container also keeps this
volume-name-agnostic (the project-prefixed name never appears):

```sh
docker compose stop emuly
docker compose run --rm -T emuly tar czf - -C /app/.data . > emuly-data.tgz
docker compose start emuly
```

Restoring is the inverse, into the same path, also with the app stopped
(`-T` keeps compose from allocating a TTY, which would corrupt binary stdin).
The restore **replaces** the data directory, so clear it first: tar only
overlays, and a stale `emuly.db-wal` left behind would be replayed by SQLite
over the restored database:

```sh
docker compose stop emuly
docker compose run --rm -T emuly sh -c 'find /app/.data -mindepth 1 -delete && tar xzf - -C /app/.data' < emuly-data.tgz
docker compose start emuly
```

The gh volume contains a live token — keep it private, or simply log in again
after a restore instead of copying it.

To start over, `docker compose down -v` removes both volumes. Your phones live
in your GitHub Codespaces and survive this — but Emuly does not re-register
them on the next start: a fresh database has no record of them, and Emuly only
manages the phones it has recorded. Either restore the backup from above, or
manage (and delete) the surviving Codespaces directly in GitHub.

## Limitations

- **Webhooks are outbound.** Emuly delivers webhook events itself to the
  receiver URLs you register; GitHub never calls Emuly, so Emuly does not need
  a public URL and stays on loopback. What must be reachable is each receiver,
  from the container: inside Docker, `localhost` names the container itself, so
  use the host's address for a receiver on the host, and note the webhook
  policy requires public addresses (plain HTTP only for localhost, and only
  while Emuly itself runs on localhost). If a receiver flow genuinely needs a
  base URL for Emuly, set `EMULY_BASE_URL` in the compose environment —
  there is a commented example in `deploy/selfhost/compose.yaml`. The API
  behind a public URL stays unauthenticated, so front it with your own auth.
- **One user.** Every request resolves to the gh-signed-in account; agent keys
  you create still work, but there is no second account and no sign-up page.
- **Unauthenticated API.** Anyone who can reach the port can drive your phones.
  Publish on loopback, or put your own front (VPN, Tailscale, reverse proxy with
  auth) in front of it.
- **No token rotation in the database.** gh owns the token and refreshes it. Do
  not set `GH_TOKEN`/`GITHUB_TOKEN`: it bypasses gh's store and usually lacks the
  `codespace` scope, so Emuly refuses to start with it set.

## Update notice

Once a day, the server reads the latest version number from the Emuly repository on GitHub.
It sends nothing about you. If your copy is older, `GET /v1/phones` includes an `update` field.
Your agent asks you once. If you say no, the server saves that in `update-dismissed` next to the
database. It does not ask again until a newer version comes out. To turn the check off, set
`EMULY_UPDATE_CHECK=0`.

## Checks and repair

- `pnpm emuly doctor` (or `docker compose run --rm emuly node bin/emuly.mjs doctor`)
  reports what is missing: gh version, a signed-in account, the `codespace`
  scope, `gh auth token`, and a writable data directory.
- A scope error from GitHub: run the `gh auth refresh -h github.com -s codespace`
  command from the table above.
- A request reports the GitHub account is blocked in the local Emuly database:
  the database was carried over from hosted-style use and that account was
  blocked there. Unblock the user row (or reset the database volume) and start
  again.
- The identity looks wrong: check gh's active account with `gh auth status` and
  switch with `gh auth switch -h github.com`. Identity refresh can take five minutes.
