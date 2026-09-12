# Self-hosted, server-rendered build (ADAPTER=node). Build from the repository root:
#   docker build -f apps/web/Dockerfile -t starterdough-web .
FROM oven/bun:1.4 AS base
WORKDIR /repo

FROM base AS build
COPY package.json bun.lock bunfig.toml ./
COPY apps/web/package.json apps/web/
COPY packages/ packages/
RUN bun install --frozen-lockfile
COPY apps/web/ apps/web/
ENV ADAPTER=node
# The Content-Security-Policy of every page this app serves is derived from these at build time
# (apps/web/vite.config.ts reads them through vite's `loadEnv`, which covers the process
# environment). Passing them only at run time is not enough: the policy would keep its localhost
# defaults, and the browser would then block every request the app makes to its own API: a login
# that fails with nothing in the API's log. `.dockerignore` keeps `.env` files out of the build
# context on purpose, so a build arg is the only way in. infra/compose.yml and
# .github/workflows/deploy.yml pass them from the same values the runtime environment uses.
# Empty is fine and means "not configured": that origin is simply left out of the policy.
ARG PUBLIC_API_URL
ARG PUBLIC_STORAGE_ORIGIN
ARG PUBLIC_SENTRY_DSN
ARG PUBLIC_POSTHOG_KEY
ARG PUBLIC_POSTHOG_HOST
ENV PUBLIC_API_URL=$PUBLIC_API_URL
ENV PUBLIC_STORAGE_ORIGIN=$PUBLIC_STORAGE_ORIGIN
ENV PUBLIC_SENTRY_DSN=$PUBLIC_SENTRY_DSN
ENV PUBLIC_POSTHOG_KEY=$PUBLIC_POSTHOG_KEY
ENV PUBLIC_POSTHOG_HOST=$PUBLIC_POSTHOG_HOST
RUN cd apps/web && bun run build

FROM base AS runtime
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
# Production dependencies only (workspace packages resolve through the same layout)
COPY package.json bun.lock bunfig.toml ./
COPY apps/web/package.json apps/web/
COPY packages/ packages/
RUN bun install --frozen-lockfile --production
COPY --from=build /repo/apps/web/build apps/web/build
USER bun
EXPOSE 3000
# --start-period: failures while the Node/Bun server boots do not count towards `retries`.
HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=30s CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1))"]
# ORIGIN must be the public URL of the app (e.g. https://app.example.com); set it in compose.
CMD ["bun", "apps/web/build/index.js"]
