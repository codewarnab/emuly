# Self-host with Docker

One container runs the whole app: the Next UI, the backend and the phone stream
proxy. Sign-in is the gh CLI inside the container — no GitHub OAuth App, no
client secret, no `.env.local`. See [docs/SELF-HOST.md](../../docs/SELF-HOST.md)
for the full guide, volumes, backups and limitations.

## Quickstart

```sh
docker compose build
docker compose run --rm emuly gh auth login -h github.com -s codespace
docker compose up
```

Then open `http://localhost:4321`.

- The login uses gh's device flow and stores the token in the `emuly-gh` volume,
  so it survives restarts.
- If GitHub says the scope is missing:
  `docker compose run --rm emuly gh auth refresh -h github.com -s codespace`.
- Health check:
  `docker compose run --rm emuly node emuly.mjs doctor`.
- Reset (keeps your phones; they live in your codespaces):
  `docker compose down -v`.

The port is published on loopback only. The self-host API is intentionally
unauthenticated — do not expose it.
