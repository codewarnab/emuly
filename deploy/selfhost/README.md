# Self-host with Docker

One container runs the whole app: the Next UI, the backend and the phone stream
proxy. Sign-in is the gh CLI inside the container — no GitHub OAuth App, no
client secret, no `.env.local`. See [docs/SELF-HOST.md](../../docs/SELF-HOST.md)
for the full guide, volumes, backups and limitations.

## Quickstart

Follow [docs/SELF-HOST.md](../../docs/SELF-HOST.md): it has the build, the gh sign-in, the start
command, the health check and the reset. Then open `http://localhost:4321`.

The port is published on loopback only. The self-host API is intentionally
unauthenticated — do not expose it.
