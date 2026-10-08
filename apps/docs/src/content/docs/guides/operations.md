---
title: Operations
description: VPS + Tailscale, Caddy modes, backups, OpenTelemetry, health, CI image push and deploy, secrets, audits and load tests.
---

The kit ships as a compose stack you can run on one VPS (or a home server) and reach from anywhere
through Tailscale. This page is the short version of `infra/README.md`. The full runbook lives
there, next to the files.

## First boot

```sh
# one-time: Docker, Tailscale, a `deploy` user, ufw, the clone, .env with generated secrets
curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/infra/scripts/provision.sh \
  | sudo REPO_URL=https://github.com/<you>/<repo>.git EXPOSE=tailscale bash

su - deploy                        # or: sudo -iu deploy
cd /opt/starterdough
# fill DOMAIN (public) or WEB_URL / API_URL (tailnet). provision.sh already set CADDY_MODE and
# generated the secrets .env needs; see Configuration
docker compose up -d --build
```

Then create the first platform administrator from the checkout on the box. `provision.sh` installs
Bun for the deploy user and writes a `DATABASE_URL` for the compose Postgres (published on loopback
only) into `.env`:

```sh
bun install
ADMIN_PASSWORD='…' bun run admin:create -- --email you@example.com --name 'You'
```

The password comes from `ADMIN_PASSWORD`, or from an interactive prompt when that is unset. It is
never read from the command line, because arguments stay in shell history and are visible in `ps`
to every user of the box. The script uses the kit's own auth config (no `bunx`, no CLI download, no
network), so it also works inside the `api` container. On a box you set up by hand, prefix the
command with `DATABASE_URL=postgres://starterdough:<POSTGRES_PASSWORD>@127.0.0.1:5433/starterdough`.

Sign in as that user and open `/admin`.

Always run `docker compose` from the repository root. `.env` sets `COMPOSE_FILE=infra/compose.yml`,
so no `-f` is needed and interpolation (`DOMAIN`, `CADDY_MODE`, `POSTGRES_PASSWORD`) comes from the
same file. `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET` are required: compose stops with
`set … in .env` instead of starting on a placeholder. Migrations run automatically (`migrate`
one-shot). `api` starts after it exits 0.

Optional services are compose profiles. Put them in `COMPOSE_PROFILES` in `.env`, not on the command
line: `infra/scripts/deploy.sh` runs `up --remove-orphans`, which removes the containers of every
profile that is not active in that invocation.

Every service runs with `no-new-privileges` and `cap_drop: ALL` (Caddy adds back only
`NET_BIND_SERVICE`) under a 512-process cap. Postgres gets `shm_size: 1gb` for parallel scans.

| Profile | Service | What |
| --- | --- | --- |
| `backup` | `backup` | nightly `pg_dump`, S3 copy, heartbeat (`infra/backup`; see Backups below) |
| `monitoring` | `uptime-kuma` | uptime + alerting on `127.0.0.1:3001` |
| `observability` | `lgtm` | Grafana + Tempo + Loki + Prometheus on `127.0.0.1:3030`. Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://lgtm:4318` |

```sh
# after enabling the backup profile: prove it works now instead of waiting for 02:30 (or set BACKUP_ON_START=true)
docker compose run --rm backup bun src/cli.ts backup
```

## Caddy modes

| | `subdomains` | `single-origin` |
| --- | --- | --- |
| Use | a public domain | a tailnet / LAN host |
| Layout | `DOMAIN`, `docs.`, `app.`, `api.` | `/` app, `/api /rpc /healthz /readyz` API, `/docs` docs |
| TLS | Caddy + Let's Encrypt | terminated upstream (`tailscale serve` / `funnel`) |
| Cookies | `COOKIE_DOMAIN=.DOMAIN` | same origin, no CORS |

Both Caddyfiles set HSTS / `nosniff` / `X-Frame-Options` / `Referrer-Policy` / `Permissions-Policy`,
write JSON access logs, forward one `X-Forwarded-For` and an `X-Request-Id`, and hold requests for
up to 15 s while an upstream restarts (active health checks on `/readyz` and `/healthz`).

Request bodies are capped at the edge at **1 MB**. Over that Caddy answers `413` before anything
reaches an upstream. Header, body-read and idle timeouts are set. There is **no write timeout**,
because it would cut a server-sent event stream mid-flight. The two static sites get their own
`Content-Security-Policy` from Caddy: the docs' one allows `cdn.jsdelivr.net` for the interactive
API reference, the marketing site's allows no third party at all. Both still need
`'unsafe-inline'` for styles and Astro's inline scripts. The access log **deletes** `sig`, `token`,
`code`, `state` and `email` from the query string it records, so an emailed reset link never lands
in a log file.

Caddy's ports are published on `CADDY_BIND` (default `0.0.0.0`). Docker-published ports bypass ufw,
so with `EXPOSE=tailscale` `provision.sh` sets `CADDY_BIND=127.0.0.1`. Only `tailscale serve` and
`funnel`, which proxy to loopback, reach Caddy.

```sh
sudo tailscale serve --bg 80     # tailnet only
sudo tailscale funnel --bg 80    # public, no open ports
```

## What the API and the app send

Every API response carries `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` and
`Cache-Control: private, no-store`. Two exceptions: `/healthz` and `/readyz` set no cache header
(machines poll them), and `/api/auth/reference` is exempt from the CSP because Better Auth's Scalar
page loads a CDN script. That page and `/api/auth/open-api/generate-schema` are 404 in production.

Behind Caddy's cap the API bounds bodies again: `/rpc/*` and `/api/v1/*` answer `413`
`payload_too_large` over 1 MiB.

The limiter on the procedure surface, 300 requests per minute per IP, is **in-process**. It is sized
for one API container. Running several replicas behind Caddy needs a shared store first.

`apps/web` adds `Cross-Origin-Opener-Policy: same-origin` to every page and
`Cache-Control: private, no-store` to `/app` and `/admin`. Its service worker caches the build and
the prerendered public pages only, never a navigation. It answers a failed navigation with
`/offline` and clears its caches on sign-out. `robots.txt` disallows `/app` and `/admin`.

## Backups

```sh
# COMPOSE_PROFILES=backup belongs in .env, not on the command line: deploy.sh runs
# `up --remove-orphans`, which drops the containers of every profile not active in that invocation.
docker compose up -d                                                  # with COMPOSE_PROFILES=backup set
docker compose run --rm backup bun src/cli.ts backup                  # one backup, now
docker compose run --rm backup bun src/cli.ts list                    # disk + bucket; exits 1 on a stale set
docker compose run --rm backup bun src/cli.ts restore latest --drill  # into a scratch database, then dropped
```

`list` **exits 1** when the newest restorable set is older than `BACKUP_MAX_AGE` (36 h), or when
there is none. That makes it usable from cron or a health check, and it is the only check that
detects a *stale* backup rather than a failed one. `--no-max-age` turns the check off while you are
browsing a recovery box. Separately, `BACKUP_CATCHUP` (on by default) takes one backup at start when
the newest set is older than a schedule interval, because `Bun.cron` has no catch-up and a reboot
past 02:30 would otherwise skip the night. The drill restores into a scratch database and asserts
the dump's checksum **and** the row counts recorded in the manifest.

A dump without the `.env` (or its [SOPS](/guides/operations/#secrets) copy) is not a restore.

Without `BACKUP_S3_BUCKET`, backups stay on the same disk and the tool warns. Point
`BACKUP_HEARTBEAT_URL` at Healthchecks.io or an Uptime Kuma push monitor so a missed night alerts
you.

A real restore needs `--yes`. Without it the CLI prints what it *would* run and stops. It writes
`starterdough_<stamp>_pre_restore.dump` into the backups directory first, so a restore of the wrong
stamp is itself recoverable (`--no-safety-dump` skips it; safety dumps are never pruned).

Before it touches the database the tool refuses three things. Only two of the refusals have an
override:

- the dump is re-hashed against the `sha256` in the set's manifest. A mismatch is **never**
  overridable; the only safe answer is another set. (`--no-manifest-check` waives a *missing*
  manifest, not a failed hash.)
- `manifest.database` must match the target, so a staging dump cannot land in production
  (`--force-database-mismatch`);
- no other session may be connected. Stop the API (`docker compose stop api`) or pass
  `--terminate-connections`.

The restore itself runs `--single-transaction --exit-on-error` under `BACKUP_LOCK_TIMEOUT`, so it is
all-or-nothing and fails instead of hanging on a writer's lock. A very large schema can exhaust
`max_locks_per_transaction` (`out of shared memory`): raise that setting, or pass
`--no-single-transaction`, knowing that a failure then leaves the database half-restored. Only one
backup or restore of a database runs at a time (a Postgres advisory lock), so a manual backup cannot
capture a half-restored database and pass verification.

The dump is **plaintext**: password hashes, sessions, email addresses, every column. Every run says
so. Encrypt the volume holding `BACKUP_DIR`, turn on server-side encryption in the bucket, give the
backup a **write-only** credential (`PutObject` + `HeadObject`), prune by lifecycle rule rather than
by delete permission, and keep object versioning (or object lock) on so a leaked key cannot erase
the history. Each set's manifest also records `rowCounts`.

Bare metal, from nothing (`pg_dump` captures neither roles nor the database itself, so Postgres has
to exist before the restore):

```sh
# new box → provision.sh → restore the .env you kept with the backups (and the backup files themselves)
docker compose up -d postgres
docker compose run --rm backup bun src/cli.ts restore <stamp> --yes
docker compose up -d
```

Variables and every restore flag: `infra/backup/README.md`.

## Health, logs, traces

| Signal | Where |
| --- | --- |
| Liveness | `GET /healthz` on the API and the web (process up): container health checks on api/web/caddy, Caddy's active checks |
| Readiness | `GET /readyz` on the API (database reachable). Caddy only routes to a ready API. A 503 answers `{"status":"unavailable","checks":{"database":"timeout"}}` (or `"unreachable"`) and nothing more. *Why* is in the API's `readiness check failed` log line (`check`, `outcome`, `reason`). Concurrent probes share one bounded `select 1`, so polling a hung database costs one connection |
| Logs | `docker compose logs -f api`. JSON lines in production (`LOG_FORMAT`, `LOG_LEVEL`). Every line written while a request is handled carries its `requestId` (Caddy's `X-Request-Id`). Procedure calls also carry `procedure` (e.g. `account.me`), and `traceId` when tracing is on. A 500 repeats the id to the caller: `{"error":"internal_error","requestId":…}`. Grep that |
| Traces | `OTEL_EXPORTER_OTLP_ENDPOINT`: the `observability` profile, or Grafana Cloud / Axiom / Honeycomb (`OTEL_EXPORTER_OTLP_HEADERS`). Health probes (`/healthz`, `/readyz`) are not traced, and query strings are stripped from span URLs |
| Uptime | `COMPOSE_PROFILES=monitoring` in `.env` (Uptime Kuma, a stock container; add monitors for `http://api:3000/readyz`, `http://web:3000/healthz` and the backup heartbeat), or Better Stack from the outside |
| System page | `/admin/system`: version, migrations, providers |

## Deploy from CI

`.github/workflows/deploy.yml` is off until the repository variable `DEPLOY_ENABLED` is `true`, so
in a new repository a push runs CI and nothing else. Once it is on, it follows CI: when CI passes
for a push to `main`, it builds the images behind `infra/compose.yml` from that exact commit and
pushes them to `ghcr.io/<owner>/<repo>` tagged `sha-<commit>` plus `main` and `latest`. A commit
whose CI fails, or that `main` has already moved past, is never built or deployed. A `v*` tag
builds images tagged with the version and deploys nothing. The `caddy` image bakes the canonical
URLs of the two static sites at build time, so it **requires** four repository variables
(`SITE_URL`, `DOCS_URL`, `WEB_URL`, `API_URL`) and fails with a message naming them rather than
shipping `example.com`. Set the repository variable `DEPLOY_HOST` and the secret `DEPLOY_SSH_KEY`,
and the workflow pushes the commit into the server's checkout, logs the server into GHCR and runs
`infra/scripts/deploy.sh` on it (`docker compose pull`, `up -d --wait`, `/readyz`), passing
`IMAGE_REGISTRY` so a fork's `.env` never has to name the registry by hand. The server never
fetches from GitHub, so a private repository needs no deploy key or token on the box. For a server
that is only on your tailnet, set `DEPLOY_VIA_TAILSCALE=true` and add a Tailscale OAuth client.
The one-time setup, in order, is in `infra/README.md` ("Deploy, update, roll back").

Pulling the images by hand needs a login of your own. `IMAGE_REGISTRY` must point at your fork's
namespace, and private packages need `docker login ghcr.io` with a token that has `read:packages`
(the workflow's login uses a token that expires with the job).

Rollback: Actions → Deploy → Run workflow with `tag: sha-<previous>` (skips the build), or
`IMAGE_TAG=sha-abc1234 GIT_REF=abc1234 bash infra/scripts/deploy.sh` on the box. A run by hand
deploys only a commit that passed CI on a push to `main`. `deploy.sh` pins the deployed tag *and*
registry in `.env`, so the rollback survives a later `docker compose up -d`. A `sha-…` tag or a
released version (`1.2.0` → its git tag's commit) is deployed with the matching commit checked
out. Anything the workflow cannot resolve to a commit fails instead of deploying old images against
current `main`. Migrations are forward-only: roll back code, not schema.

## Secrets

`provision.sh` writes a `chmod 600` `.env` with generated `BETTER_AUTH_SECRET` and
`POSTGRES_PASSWORD`. In production the API refuses the example placeholders: any `change-me…`
value, and a `DATABASE_URL` whose password is `starterdough`, `postgres` or `change-me…`. Generate
every secret (`openssl rand -hex 32`). To version the file, encrypt it with SOPS + age into
`infra/env/production.enc.env` (see `/.sops.yaml` and `infra/env/README.md`). CI decrypts with the
`SOPS_AGE_KEY` secret. 1Password (`op inject`) and Doppler work the same way: the containers only
ever see environment variables.

## Audits and load

CI runs `bun audit --prod --audit-level=high`, `bun run licenses --strict`,
`cargo fmt --check` / `clippy` / `check` on the Tauri crate, the Playwright end-to-end suite (home,
axe/WCAG 2.2 AA, locales) against a production preview of `apps/web`, `docker compose config`
(every profile) + `caddy validate` on both Caddyfiles, the backup tool's integration suite against
a real Postgres 17, and, on pull requests, a build of all four images. Every action is pinned to a
commit SHA; the pins move with each release of the kit.

```sh
docker run --rm -i -e API_URL=http://<api-origin> grafana/k6 run - < infra/loadtest/k6/smoke.js
# optional signed-in scenario: -e K6_EMAIL=… -e K6_PASSWORD=…
```

Aim it at the API directly, not through Caddy. The script gives every virtual user its own
`X-Forwarded-For` address so the per-IP limiter sees many clients. That only works where the API
trusts that header (`TRUST_PROXY=true`, what `infra/compose.yml` sets on the `api` service) and
where Caddy is not in front rewriting it to the real client address. The header must hold exactly
one address (a chain falls back to the socket). Against an API started without `TRUST_PROXY=true`,
every virtual user lands in the same bucket. Tune `DATABASE_POOL_MAX` so the whole stack stays
under Postgres `max_connections` (100 by default): `DATABASE_POOL_MAX` per API process, 2 for
`migrate` while it runs, 1 for `backup`, plus your own `psql`.

The full runbook (firewall, troubleshooting, image tags) is `infra/README.md`.
