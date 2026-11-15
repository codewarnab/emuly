# Emuly self-host: one container runs the whole app (Next UI + backend + stream proxy).
# Sign-in is the gh CLI inside the container: its credential store lives in the /gh
# volume, so `gh auth token` can serve and auto-refresh the token at request time.
# The EMULY_SELF_HOST flag must also be set during this build: bundles may inline it.

FROM node:26-bookworm-slim AS build
WORKDIR /app
# Present at build time too: the proxy bundle can inline env, so a runtime-only flag
# could leave self-host code compiled out.
ENV EMULY_SELF_HOST=1
RUN npm install -g pnpm@12.8.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# The prerendered pages open the database, so migrate before building.
RUN pnpm db:migrate && pnpm build && rm -rf .next/cache
# The custom stream server imports source modules outside Next tracing. Ship production
# dependencies rather than standalone, which does not trace this custom entrypoint.
RUN pnpm --filter emuly deploy --prod --legacy /runtime

FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV EMULY_SELF_HOST=1 GH_CONFIG_DIR=/gh PORT=4321 HOST=0.0.0.0
# gh >= 2.103 auto-refreshes expiring tokens before `gh auth token` prints them.
# The devcontainers/github-cli image stopped publishing, so install the official deb.
# dpkg's architecture name matches gh's deb naming (amd64, arm64) without BuildKit's
# auto-provided TARGETARCH, which podman does not set. git is gh's deb dependency.
ARG GH_VERSION=2.104.0
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_$(dpkg --print-architecture).deb" -o /tmp/gh.deb \
  && dpkg -i /tmp/gh.deb && rm /tmp/gh.deb \
  && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json pnpm-lock.yaml next.config.ts tsconfig.json instrumentation.ts ./
COPY bin ./bin
# lib/ source must ship: the stream proxy dynamically imports ./phone-control.ts outside
# the Next bundle, and the agent runbook reads content/ at request time.
COPY lib ./lib
COPY content ./content
COPY public ./public
COPY phone ./phone
COPY scripts/migrate-database.ts ./scripts/migrate-database.ts
# Owned by the node user so the app can write the database and the token key there.
RUN mkdir -p /gh .data && chown node:node /gh .data
USER node
CMD ["node", "bin/emuly.mjs", "up", "--prod", "--no-browser"]
