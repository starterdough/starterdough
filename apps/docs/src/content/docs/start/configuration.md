---
title: Configuration
description: Every environment variable, what it switches on, and what happens when it is left empty.
---

Configuration is plain environment files, one per process. The API validates its variables once at
start-up (`packages/env`, t3-env + Zod) and refuses to boot on a bad value. Set
`SKIP_ENV_VALIDATION=1` only for steps that never start the app (type checks, CI builds). Values are
still parsed, so numbers and booleans keep their types. Only the cross-field rules below are skipped,
and `DATABASE_URL` / `BETTER_AUTH_SECRET` get placeholders.

Three cross-field rules refuse a boot outright. The first two apply in **production** only:

- no `RESEND_API_KEY`: the console provider would write every verification and password-reset URL,
  token included, into the log;
- an `EMAIL_FROM` whose domain is `localhost`, `example.*`, reserved or dotless: the provider rejects
  the send and sign-up looks like it worked;
- a `COOKIE_DOMAIN` that is not a bare hostname covering both `WEB_URL` and `API_URL`: the browser
  drops the session cookie silently. This rule applies in every environment.

Optional subsystems switch on when their variables are present and stay off otherwise: social
sign-in, a real email provider, error tracking, analytics. The kit runs with the defaults from
the example files.

| File | Read by |
| --- | --- |
| `.env` (repository root, from `.env.example`) | the API, database tooling, Docker Compose |
| `apps/web/.env` (from `apps/web/.env.example`) | the SvelteKit app (Vite; only `PUBLIC_*` values reach the browser) |
| `apps/site/.env`, `apps/docs/.env` | the Astro sites, at build time |

Check the app configuration with `bun run doctor`; add `-- --build` to check both Astro sites
before a full build. Use `-- --database=external` when `DATABASE_URL` points to an existing database.
The checker covers local development/test setup and refuses `NODE_ENV=production`; full environment
validation belongs to the API at startup. It never applies migrations or confirms database connectivity.

### Local app versus complete build

`dev:app` needs the root and web settings. `build` also requires **each site's own** canonical URL:
set `SITE_URL=http://localhost:4321` in `apps/site/.env` and `SITE_URL=http://localhost:4322` in
`apps/docs/.env` for local builds. Keep their public API/app targets consistent with your ports.
Before deployment, replace local origins with your public URLs.

Astro's canonical setting uses a nonempty explicit process `SITE_URL` first, then its own
`.env.local`, then `.env`. Blank canonical entries fall through to the next source. A nonempty
shell export applies to both sites, so leave it unset when using distinct per-site files. The root
`DOCS_URL` belongs to container builds; a direct docs build uses `apps/docs/.env`'s `SITE_URL`.
The build still rejects an unset canonical URL or an `example.com`, `example.org` or `example.net`
placeholder.

Never commit `.env` files. Only the `.env.example` files are tracked. In production the API refuses
the example placeholders: any `change-me…` value (`BETTER_AUTH_SECRET`, the OAuth secrets,
`RESEND_API_KEY`) and a `DATABASE_URL` whose password is `starterdough`,
`postgres` or `change-me…`. Generate every secret you fill in:

```sh
bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`openssl rand -hex 32` does the same where OpenSSL is installed. PowerShell has no `openssl`.
`POSTGRES_PASSWORD` is not one of the API's own variables; the compose stack refuses to start while
it is empty.

## API and infrastructure: root `.env`

### Core

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production`. Production turns on email verification and Better Auth's rate limits by default. |
| `PORT` | `3000` | Port the API listens on. |
| `API_URL` | `http://localhost:3000` | Public origin of the API: what browsers and shells call, and the base for OAuth callbacks and webhooks. |
| `WEB_URL` | `http://localhost:5173` | Public origin of the web app. Used for CORS, auth redirects, trusted origins and the passkey `rpID`. |
| `TRUSTED_ORIGINS` | `tauri://localhost,http://tauri.localhost` | Extra origins allowed to call the API (comma-separated): Tauri shells, LAN devices, tailnet hosts, the public site if its contact form should reach the API. |
| `COOKIE_DOMAIN` | empty | Parent domain the session cookie is scoped to (e.g. `.example.com`) when web and API live on sibling subdomains. A **bare hostname**, never a URL. The value goes verbatim into `Set-Cookie`'s `Domain`, and both `WEB_URL` and `API_URL` must sit under it; anything else is refused at start-up. Single-origin deployments leave it empty. |
| `PUBLIC_WEB_URL` | empty | Deployed origin of the web app as the *browser* sees it. Only the Tauri shells need it: their own origin is `tauri.localhost`, which no external provider can return to, so OAuth and similar round trips go here instead. Unset, the buttons that start them are hidden. Set it where the shell is built (a repository variable for the Desktop workflow, `apps/web/.env` for a hand build). A browser deployment leaves it empty, and the compose stack does not pass it to the `web` container. |
| `PUBLIC_DEMO_MODE` | empty (off) | Public demo deployment. `true` shows a banner in the app and adds `noindex` to every page. The web app reads the same variable (`apps/web/.env`, or the web container's environment). |

### Database

| Variable | Default | Meaning |
| --- | --- | --- |
| `POSTGRES_PORT` | `5433` | Loopback host port of the Postgres container. `bun run db:up` uses it in development (5433 keeps clear of a local Postgres on 5432). The compose stack uses it in production (default 5432 there, see Self-hosting). |
| `DATABASE_URL` | `postgres://starterdough:starterdough@localhost:5433/starterdough` | The only Postgres client is the API (Bun's native `Bun.SQL` through Drizzle). `packages/db/drizzle.config.ts` falls back to the same URL, so `db:generate` and `db:studio` reach the `db:up` container on 5433. Add `?sslmode=require` (or your provider's equivalent) for a managed database reached over the public internet. |

`bun run db:migrate` checks afterwards that nothing is still pending and **exits 1** when something
is. Drizzle's migrator compares each file against the newest applied timestamp and skips a migration
that sorts before it, which is what merging a branch can produce. Regenerate those migrations so they
sort last, or apply them by hand.

### Auth (Better Auth)

| Variable | Default | Meaning |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | none (required, 32+ characters) | Signs sessions and tokens. `.env.example` ships it **empty**. Generate one with `bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. In production the API refuses a `change-me…` placeholder, and the compose stack refuses to start while it is empty. Keep it with your backups: a restored database without it cannot validate any session. |
| `REQUIRE_EMAIL_VERIFICATION` | empty → `true` in production, `false` otherwise | Whether a verified email is required before a session is issued. The console email provider prints the verification link in development. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | empty | GitHub sign-in is enabled when both are present. Callback URL: `${API_URL}/api/auth/callback/github`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | empty | Google sign-in, same rule. Callback URL: `${API_URL}/api/auth/callback/google`. |

The sign-in UI asks the API which providers are live (`GET /api/v1/auth-config`), so nothing needs
to be mirrored into the frontend's environment.

### Email

| Variable | Default | Meaning |
| --- | --- | --- |
| `RESEND_API_KEY` | empty | Empty = emails are printed to the API console (development only: **the API refuses to boot in production without it**). Set it to send through Resend. |
| `CONTACT_EMAIL` | empty | Recipient of the public site's contact / waitlist form (`POST /api/v1/contact`). Empty is fine while emails go to the console. With Resend configured the form answers `412` until this is filled. |
| `EMAIL_FROM` | `Starterdough <noreply@localhost>` | Sender of every email (verification, reset, email change, account deletion). The code default is `noreply@localhost`, which no real provider accepts. `.env.example` ships `Starterdough <noreply@example.com>` as a shape to copy. Set it to an address on a domain you have verified with your provider before turning `RESEND_API_KEY` on. In production the API refuses to boot while the domain is `localhost`, `example.*`, reserved or dotless. |

### Operations

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRUST_PROXY` | `false` | Take the first `X-Forwarded-For` hop as the client address for the per-IP rate limits and the access log's `ip`, and only when the header holds exactly one address (a chain falls back to the socket address). Turn it on **only** behind a reverse proxy that sets the header itself (`infra/compose.yml` sets it on the `api` service, which sits behind Caddy). Where the API port is reachable directly, it would let any client choose the address it is limited by. |
| `OTEL_EXPORTER_OTLP_HEADERS` | empty | Headers for hosted collectors, `key=value` pairs comma-separated (e.g. `Authorization=Bearer …`). |
| `LOG_FORMAT` | empty → `json` in production, `pretty` otherwise | Log format of the API. JSON lines carry `requestId` (Caddy's `X-Request-Id`) and, with tracing on, `traceId`. |
| `LOG_LEVEL` | empty → `info` in production, `debug` otherwise | Lowest level the API logs: `debug`, `info`, `warn` or `error`. A failed database query is logged with its root cause only. `query`, `params` and `sql` are redacted, because Drizzle attaches the statement and every bound parameter (session tokens included) to the error it throws. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty (off) | OTLP/HTTP collector for traces from the API: `http://lgtm:4318` with the `observability` compose profile, or Grafana Cloud / Axiom / Honeycomb. Nothing is loaded while empty. |
| `OTEL_SERVICE_NAME` | set per service by compose | Service name on the spans. There is no row for it in `.env.example`: one `env_file` feeds `api` and `migrate`, so a value there would label both the same. `infra/compose.yml` sets `starterdough-api` per service. It only matters when you run a process outside compose. |
| `DATABASE_POOL_MAX` | `10` | Postgres connections held by one API process. Postgres allows 100 by default. Keep the total below that: `DATABASE_POOL_MAX` per API process, 2 for `migrate` while it runs, 1 for `backup`, plus any `psql` of your own. |

See [Operations](/guides/operations/).

### Self-hosting (`infra/compose.yml`)

Run `docker compose` from the repository root. `COMPOSE_FILE` in `.env` points it at the stack, and
the stack reads the same `.env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMPOSE_FILE` | `infra/compose.yml` | Lets `docker compose …` from the root find the production stack (and read this file for its values). |
| `DOMAIN` | empty | Public domain. In `subdomains` mode Caddy serves `DOMAIN`, `docs.DOMAIN`, `app.DOMAIN`, `api.DOMAIN` with certificates from Let's Encrypt. **Ships empty on purpose**: a placeholder would have Caddy request an ACME certificate for a domain you do not own and retry for ever. Empty falls back to `localhost` and Caddy's internal CA: the stack comes up, the browser warns about the certificate, and nothing is attempted against Let's Encrypt. Fill it in (and point the four DNS records here) when you go public. Not used with `CADDY_MODE=single-origin`. |
| `ACME_EMAIL` | empty | Contact address for Let's Encrypt: expiry warnings and account recovery. Optional, but it is the only notice you get before a certificate that stopped renewing runs out. |
| `POSTGRES_PASSWORD` | none (required) | Password of the compose Postgres, used for the container and the API's connection string. Ships empty: `docker compose` stops with `set POSTGRES_PASSWORD in .env` rather than starting the database on a guessable one (`bun -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`). Changing it later does not change the database's password, because the volume already exists. |
| `CADDY_MODE` | `subdomains` | `subdomains` (public, automatic HTTPS, set `COOKIE_DOMAIN=.DOMAIN`) or `single-origin` (tailnet/LAN, path routing; set `WEB_URL` and `API_URL` to that one origin, so there is no CORS). |
| `CADDY_BIND` | empty → `0.0.0.0` | Host address Caddy's ports are published on. Use `127.0.0.1` behind `tailscale serve`/`funnel` (they proxy to loopback, and Docker-published ports bypass ufw). `provision.sh` sets it from `EXPOSE`. |
| `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` | `80` / `443` | Host ports Caddy binds. Behind Tailscale only 80 is used. |
| `POSTGRES_PORT` | `5432` | The compose Postgres is published on loopback only (`127.0.0.1:${POSTGRES_PORT:-5432}`) for `bun run admin:create` and `psql` from a host checkout. The shipped `.env.example` sets 5433 (the `db:up` port), so a provisioned box listens on 5433 unless you change it. |
| `UPTIME_KUMA_PORT` | `3001` | Loopback port of Uptime Kuma (profile `monitoring`). |
| `GRAFANA_PORT` | `3030` | Loopback port of Grafana (profile `observability`). |
| `IMAGE_REGISTRY` / `IMAGE_TAG` | empty / `latest` | Where `docker compose pull` gets images: **your** fork's GHCR namespace, `ghcr.io/<owner>/<repo>` lowercased. The Deploy workflow pushes there, `infra/scripts/provision.sh` derives it from `REPO_URL`, and `deploy.sh` pins whatever the workflow passed. It ships **empty** on purpose: compose then falls back to the local namespace `starterdough/<name>:local`, so `docker compose pull` fails with "pull access denied" instead of fetching a stranger's build, while `docker compose up -d --build` works unchanged. `IMAGE_TAG` is set per deploy, so a rollback is an older `sha-…` tag. `up -d --build` ignores both. |
| `SITE_URL` / `DOCS_URL` | empty → derived from `DOMAIN` | Canonical URLs baked into the static sites (Caddy image). Single-origin: `DOCS_URL=https://<host>/docs`. Empty resolves to `https://localhost`, which is fine for a local `up`, but the Astro builds refuse an unset or `example.com` value. A published deploy needs the real domains here, or in `DOMAIN`. |
| `PUBLIC_SENTRY_DSN`, `SENTRY_DSN`, `PUBLIC_POSTHOG_KEY`, `PUBLIC_POSTHOG_HOST` | empty | Passed to the web container (same names as `apps/web/.env`). |
| `COMPOSE_PROFILES` | empty | Optional services: `backup` (nightly `pg_dump`), `monitoring` (Uptime Kuma), `observability` (Grafana + Tempo + Loki + Prometheus). Set them here, not with `--profile` on the command line: `infra/scripts/deploy.sh` runs `up --remove-orphans`, which removes the containers of every profile that is not active in that invocation. |
| `COMPOSE_PROJECT_NAME` | `starterdough` | Prefix of every container, network and **volume** the stack creates (`starterdough_pgdata`, `starterdough_backups`, `starterdough_caddy_data`). Renaming it after the first `up` does not rename the volumes: Compose creates a fresh empty set under the new prefix, and the database looks as though it vanished. Copy each volume across first. `bun run rename` prints the exact commands in its residue checklist. |

### Backups (profile `backup`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKUP_SCHEDULE` | `30 2 * * *` | Cron expression, UTC. |
| `BACKUP_RETENTION_DAYS` | `14` | Backups older than this are pruned, on disk and in the bucket. |
| `BACKUP_DIR` | `./backups` | Where dumps are written. `infra/compose.yml` pins the container to `/backups` (the `backups` volume), so this row only matters when you run the tool from a checkout on the host. |
| `BACKUP_ON_START` | `false` | Run one backup as soon as the scheduler container starts, instead of waiting for the next `BACKUP_SCHEDULE`. The quickest way to prove a fresh box can back up. |
| `BACKUP_CATCHUP` | `true` | Run one backup at start when the newest set is older than one schedule interval. `Bun.cron` has no catch-up, so a reboot past `BACKUP_SCHEDULE` would otherwise skip the night. |
| `BACKUP_MAX_AGE` | `36h` | `list` **exits 1** when the newest restorable set is older than this, or when there is none. That makes it usable from cron or a health check. Duration syntax: `90s`, `45m`, `36h`, `2d` (a bare number is rejected). Pass `--no-max-age` when browsing a recovery box. |
| `BACKUP_COMMAND_TIMEOUT_MINUTES` | `360` | Ceiling on any spawned `pg_dump`, `pg_restore` or `tar`, so a hung command cannot block the scheduler. |
| `BACKUP_LOCK_TIMEOUT` | `60s` | `lock_timeout` for a restore session, so a live restore fails instead of hanging on a writer's lock. |
| `BACKUP_S3_PREFIX` | `backups/` | Key prefix inside the bucket. |
| `BACKUP_HEARTBEAT_URL` | empty | `GET` after every successful backup. A Healthchecks.io check, Uptime Kuma push monitor or Better Stack heartbeat alerts you when backups stop. A failed scheduled run pings `${BACKUP_HEARTBEAT_URL}/fail`. |
| `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | empty | Off-box copy. Unset: backups stay on the machine (the tool warns). `BACKUP_S3_REGION` must be a real region (`us-east-1`, `eu-central-1`, …). `auto` is an R2/MinIO convention and is only accepted together with a `BACKUP_S3_ENDPOINT`. |

The dump is **not encrypted**. What to harden around that, every guard a restore applies and every
flag that relaxes one are in [Operations → Backups](/guides/operations/#backups).

## Web app: `apps/web/.env`

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_API_URL` | `http://localhost:3000` | Where the browser and the Tauri shells reach the API. Must be absolute. Baked into static builds. |
| `API_URL` | empty → `PUBLIC_API_URL` | Internal API origin used by server-side `load` functions during SSR (e.g. `http://api:3000` inside Docker Compose). |
| `PUBLIC_SENTRY_DSN` / `SENTRY_DSN` | empty | Error tracking in the browser / during SSR. Empty = the Sentry SDK is not loaded. Optional: `PUBLIC_SENTRY_ENVIRONMENT`, `SENTRY_ENVIRONMENT`, `PUBLIC_SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_TRACES_SAMPLE_RATE`. |
| `PUBLIC_POSTHOG_KEY` | empty | Product analytics. Empty = no consent banner, nothing loaded. Visitors must accept the banner before anything is sent. Optional `PUBLIC_POSTHOG_HOST` (default `https://us.i.posthog.com`). |
| `PUBLIC_WEB_URL` | empty | Read only by a Tauri shell build. See the root `.env` row above. |
| `PUBLIC_DEMO_MODE` | empty | The web app's half of demo mode. See the root `.env` row above. |

The app's Content-Security-Policy is **derived from these values at build time** by `csp()` in
`apps/web/vite.config.ts`. That file also holds the SvelteKit configuration; there is no
`svelte.config.js`. To allow another third-party origin (a font CDN, map tiles, a remote avatar
host), edit that function. `img-src` is `'self' data: blob:`, so a profile picture hosted by GitHub
or Google is blocked until its origin is listed there.

The deployment target is not an `.env` value. It is the `ADAPTER` variable (`node`, `cloudflare`,
`static`) read by `vite build`. See [Serve anywhere](/guides/serve-anywhere/).

## Public sites: `apps/site/.env`, `apps/docs/.env`

| Variable | App | Meaning |
| --- | --- | --- |
| `SITE_URL` | both | Canonical origin: `<link rel="canonical">`, sitemap, RSS, absolute `og:image` URLs, and the `Sitemap:` line of each site's generated `robots.txt`. Each site has its own value (the marketing origin, the docs origin). **`astro build` fails** when it is unset or still an `example.com` placeholder. `astro dev` and `astro check` fall back to `http://localhost:4321` / `:4322`. For the docs a path is allowed and becomes the base every link is served under (`https://example.com/docs` in the single-origin Caddy mode). |
| `PUBLIC_DOCS_URL` | site | Where "Docs" points. |
| `PUBLIC_API_URL` | both | The site's contact form POSTs to `${PUBLIC_API_URL}/api/v1/contact`. The docs' interactive API reference loads `${PUBLIC_API_URL}/api/v1/openapi.json`. Both are browser requests, so the API's `TRUSTED_ORIGINS` must include the sites' origins. |
| `PUBLIC_REPO_URL` | site | Optional. Your public repository: the footer link, "View on GitHub", the changelog's commit history, the contact page's "found a bug". Unset (the default) renders none of them. |
| `PUBLIC_CONTACT_EMAIL` | site | Optional. Address shown to visitors whose browser cannot run the contact form (no JavaScript). Not where the form delivers: that is the API's own `CONTACT_EMAIL`, which never reaches the browser. |
| `DOCS_REPO_URL` | docs | Optional. Repository the docs are edited in: adds the header's GitHub link and "Edit this page". Unset (the default) renders neither. |
| `PUBLIC_APP_URL` | site | Target of "Sign in" and "Open the app". |

All of them are read at build time. Rebuild after changing them. Each Astro config loads the `.env`
in its own app directory (`process.loadEnvFile`), and a value already in the environment wins over
the file, so `SITE_URL=… bun run --cwd apps/docs build` overrides `apps/docs/.env` without editing
it.
