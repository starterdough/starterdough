# Build from the repository root so workspace packages are available:
#   docker build -f apps/api/Dockerfile -t starterdough-api .
FROM oven/bun:1.4 AS base
WORKDIR /repo

# Install with the full workspace graph (cached until a manifest changes)
FROM base AS deps
COPY package.json bun.lock bunfig.toml ./
COPY apps/api/package.json apps/api/
COPY packages/ packages/
RUN bun install --frozen-lockfile --production

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json bunfig.toml ./
COPY packages/ packages/
COPY apps/api/ apps/api/
USER bun
EXPOSE 3000
# --start-period: failures during start-up (migrations gate, first pool connection) do not count.
HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=30s CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1))"]
# Bun runs TypeScript directly. For a single static binary instead, use `bun run build`
# (bun build --compile) and copy dist/api into a debian-slim image.
CMD ["bun", "run", "apps/api/src/index.ts"]
