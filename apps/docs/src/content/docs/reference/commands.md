---
title: Commands
description: The scripts in the root package.json and the per-app commands behind them.
---

All commands run from the repository root with Bun. `turbo` runs the graph-aware, cached tasks
across every workspace that defines the script.

## Development

| Command | What |
| --- | --- |
| `bun run dev` | every app with a `dev` script: api `:3000`, web `:5173`, site `:4321`, docs `:4322` |
| `bun run dev:app` | api + web only |
| `bun run dev:site` · `bun run dev:docs` | one Astro site |
| `bun run dev:desktop` | Tauri desktop shell around the dev server (needs Rust) |

## Pipeline

| Command | What |
| --- | --- |
| `bun run verify` | `lint`, `check` and `test` in CI's order. The pre-push command. Add `bun run build` for the whole pipeline |
| `bun run check` | `turbo check`: svelte-check in the app and packages, `astro check` in the sites |
| `bun run test` | `turbo test`: `bun test` in the TS packages and the API, Vitest (unit + component in Chromium) in the app, and `packages/ui`'s contrast check, which recomputes every token pair's ratio from `theme.css`. The component tests need Playwright's Chromium; `apps/web`'s `pretest` installs it on first run |
| `bun run test:e2e` | Playwright against a production preview of `apps/web` (includes axe, WCAG 2.2 AA) |
| `bun run lint` · `bun run lint:fix` | Biome check / check and write (TS, JSON, CSS, Svelte, Astro; tabs, single quotes, 100 columns) |
| `bun run format` | Biome format only |
| `bun run build` | `turbo build`: every app |
| `bun run clean` | remove build outputs |
| `bun run licenses` | audit every dependency's licence from the metadata an install left on disk. `--all` prints one line per package. `--strict` exits 1 on anything not already recorded in `THIRD-PARTY.md` (what CI runs) |
| `bun run rename` | rename the kit to your product across the tracked text files: `--name`, `--slug`, `--identifier`, `--scope`. Dry run unless `--write`. `LICENSE.md`, `THIRD-PARTY.md`, `CHANGELOG.md`, `UPGRADING.md` and the script itself are left verbatim. It prints a residue checklist of what a text substitution must not touch (Docker volumes, the dev database, `.env`, lockfiles, the kit's own repository URL) |

## Database (Drizzle Kit, `packages/db`)

| Command | What |
| --- | --- |
| `bun run db:up` · `bun run db:down` | Postgres 17 + pgvector (`pgvector/pgvector:pg17`) in Docker via `infra/compose.dev.yml` (host port `POSTGRES_PORT`, default 5433) |
| `bun run db:migrate` | apply `packages/db/drizzle/*.sql`, then verify nothing is still pending and **exit 1** if something is. A branch merge can interleave migration timestamps, which Drizzle's migrator would otherwise skip |
| `bun run db:generate` | generate a migration from the schema |
| `bun run db:push` | push the schema without a migration (development only) |
| `bun run db:studio` | Drizzle Studio |

## Auth and admin

| Command | What |
| --- | --- |
| `bun run auth:schema` | regenerate the Better Auth tables after changing plugins. Then `db:generate` and `db:migrate` |
| `bun run admin:create -- --email … [--name …] [--yes]` | create or promote the first platform administrator. The password comes from `ADMIN_PASSWORD` or an interactive prompt, never from the command line (arguments land in shell history and `ps`). It runs through the kit's own auth config with no `bunx` and no network, so it works inside the API container too. `--yes` is required to promote an account that already exists |

## API

| Command | What |
| --- | --- |
| `bun run api:openapi` | write `apps/api/openapi.json` for non-TypeScript client generation |
| `bun run --cwd apps/api worker` | run the job worker as its own process (then `WORKER_ENABLED=false` on the API) |

## Operations (`infra/`)

| Command | What |
| --- | --- |
| `docker compose up -d --build` | production stack from the repository root (`COMPOSE_FILE` in `.env`) |
| `COMPOSE_PROFILES=backup` in `.env`, then `docker compose up -d` | nightly `pg_dump` (+ uploads); `run --rm backup bun src/cli.ts backup\|list\|restore`. Profiles live in `.env`, not on the command line: `deploy.sh --remove-orphans` drops containers of profiles it cannot see |
| `sudo REPO_URL=… EXPOSE=tailscale bash infra/scripts/provision.sh` | one-time VPS setup, as root (`EXPOSE=public` opens 80/443): Docker, Tailscale, deploy user, firewall, clone, `.env`. Or `curl … \| sudo … bash` as in the runbook |
| `bash infra/scripts/deploy.sh` | pull `IMAGE_TAG`, restart, wait healthy, hit `/readyz` (what CI runs over SSH) |
| `docker run --rm -i -e API_URL=… grafana/k6 run - < infra/loadtest/k6/smoke.js` | load test the API |

See [Operations](/guides/operations/).

## Per app

These are each app's own scripts, not root ones. Run them from that directory, or from the root
with `bun run --cwd apps/<app> <script>`.

| App | Commands |
| --- | --- |
| `apps/web` | `build` (node) · `build:node` · `build:cloudflare` · `build:static` · `build:static:desktop` (into `build-static/`, what the Tauri shell bundles) · `preview` · `check` · `test` · `test:e2e` · `i18n:compile` · `deploy:cloudflare` |
| `apps/api` | `dev` · `worker` · `bun test` · `openapi` |
| `apps/site`, `apps/docs` | `dev` · `build` · `preview` · `check` · `deploy:cloudflare` (`astro build && wrangler deploy`) |
| `apps/native` | `dev:desktop` · `build:desktop` · `android:init|dev|build` · `ios:init|dev|build` · `icons` |
| `packages/ui` | `bunx shadcn-svelte@latest add <name> -c packages/ui` |
| `infra/backup` | `bun src/cli.ts backup\|list\|restore\|schedule` (image: `infra/backup/Dockerfile`) |

## Environment flags

| Variable | Effect |
| --- | --- |
| `ADAPTER=node\|cloudflare\|static` | selects the SvelteKit adapter for `vite build` in `apps/web` |
| `STATIC_OUT_DIR` | where `ADAPTER=static` writes (default `build`, the same directory the server adapters use). `build:static:desktop` sets it to `build-static` so a desktop build and a server build cannot overwrite each other |
| `SKIP_ENV_VALIDATION=1` | relax the API's env validation for steps that never boot the app (type checks, CI builds). Never for `dev` or `migrate`. Values are still parsed, so they keep their real types. Only the cross-field production rules are skipped, and `DATABASE_URL` / `BETTER_AUTH_SECRET` get placeholders |
| `ADMIN_PASSWORD` | password for `admin:create`, instead of the interactive prompt |
| `SITE_URL` | canonical origin for the Astro builds. Each site has its own. `astro build` **fails** without it, and fails on an `example.com` placeholder. `astro dev` and `astro check` fall back to `localhost:4321` / `:4322` |
