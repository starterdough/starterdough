# Infrastructure

Three ways to run the same code. Pick one per environment; nothing in the apps changes.

| | Where | What runs there | Notes |
| --- | --- | --- | --- |
| **Cloud** | Cloudflare | `apps/site`, `apps/docs` (static assets), `apps/web` (Workers, SSR) | `bun run deploy:cloudflare` in each app; `wrangler.jsonc` included |
| | One container host (Fly.io, Railway, Hetzner + Coolify, …) | `apps/api` and Postgres | Dockerfiles in each app (CI publishes them to GHCR); managed Postgres or the compose one |
| **Self-hosted** | Your VPS / home server | everything, via `compose.yml` | Caddy in front; Tailscale for private or public access. The rest of this file |
| **Local** | Your machine | `bun run dev` + `compose.dev.yml` (Postgres) | Tauri shell via `bun run dev:desktop` |

## What is in here

```
compose.yml               the production stack (postgres, migrate, api, worker*, web, ai, caddy, backup*, uptime-kuma*, lgtm*)   * = profile
compose.dev.yml           Postgres for local development (`bun run db:up`)
caddy/                    subdomains.Caddyfile (public domain) · single-origin.Caddyfile (tailnet / LAN)
caddy/conf.d/             your own site blocks, imported by both Caddyfiles (ships empty; README inside)
compose.proxy-network.yml optional overlay: caddy joins a network shared with other compose projects
demo/                     a public demo next to production: compose file, .env template, reset script + timer
docker/Dockerfile.static  builds apps/site + apps/docs into the Caddy image
backup/                   pg_dump + uploads to a volume and S3/R2, retention, restore drill (its own README)
scripts/provision.sh      one-time VPS setup: Docker, Tailscale, deploy user, firewall, clone, .env with secrets
scripts/deploy.sh         pull a tag, restart, wait for health, readiness check. CI runs this over SSH
env/                      the production .env, encrypted with SOPS + age (README inside)
loadtest/k6/smoke.js      load test (probes, public procedures, optional signed-in flow)
```

## Self-hosting with Docker Compose

**Always run `docker compose` from the repository root.** `.env` contains
`COMPOSE_FILE=infra/compose.yml`, so no `-f` is needed, and Compose reads that same `.env` for
`${DOMAIN}`, `${CADDY_MODE}`, `${POSTGRES_PASSWORD}` and the rest. `docker compose -f infra/compose.yml …`
from the root would use the right file but interpolate those values from nothing. The explicit long
form is `docker compose --env-file .env -f infra/compose.yml …`.

```sh
# new server: Docker, Tailscale, a `deploy` user, ufw, unattended upgrades, the clone, .env with fresh secrets
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/infra/scripts/provision.sh \
  | sudo REPO_URL=https://github.com/<owner>/<repo>.git EXPOSE=tailscale bash     # or EXPOSE=public

su - deploy                        # or: sudo -iu deploy
cd /opt/starterdough
$EDITOR .env                       # DOMAIN (public) or WEB_URL/API_URL for a tailnet host (below);
                                   # provision.sh already set CADDY_MODE and generated the secrets
docker compose up -d --build       # or, for the images CI pushed: see "prebuilt images" below
docker compose ps                  # every service healthy; `migrate` exited 0, `worker` has no health check
```

Four rows ship **empty on purpose**. A plausible value would produce a stack that looks healthy and
is wrong:

- `DOMAIN`: empty means `localhost` and Caddy's internal CA. Fill it in for the public mode.
- `IMAGE_REGISTRY`: empty means the local `starterdough/<name>:<tag>` namespace, so
  `docker compose pull` fails with "pull access denied" instead of fetching a stranger's build.
- `COOKIE_DOMAIN`: a bare hostname, never a URL. The browser silently drops a cookie whose `Domain=`
  is a URL and sign-in appears to work.
- `PUBLIC_STORAGE_ORIGIN`: only needed with S3/R2. The app's and the shell's CSP must allow it for
  the presigned PUT.

`POSTGRES_PASSWORD`, `SERVICE_TOKEN` and `BETTER_AUTH_SECRET` are required (`${VAR:?…}` in
`compose.yml`). `.env.example` ships them empty and compose stops with `set … in .env` rather than
starting the stack on a placeholder. `provision.sh` generates all three. In production the API also
refuses any `change-me…` secret and a `DATABASE_URL` whose password is `starterdough`, `postgres`
or `change-me…`. Generate every value you fill in yourself:

```sh
openssl rand -hex 32
```

Prebuilt images instead of building on the box:

```sh
# IMAGE_REGISTRY must name YOUR fork's namespace (ghcr.io/<owner>/<repo>, lowercase). provision.sh
# derives it from REPO_URL and deploy.sh pins whatever the workflow passed. Private packages need a
# token with read:packages. The caddy image is only correct if the four repository variables
# (SITE_URL, DOCS_URL, WEB_URL, API_URL) were set when CI built it; they are baked in.
docker login ghcr.io && docker compose pull && docker compose up -d
```

Migrations run automatically. The `migrate` service applies `packages/db/drizzle`, and `api` and
`worker` only start once it has exited successfully. Every `docker compose up` repeats that (a no-op
when nothing is pending).

Create the first platform administrator from the checkout on the box. `provision.sh` installs Bun
for the deploy user and writes a `DATABASE_URL` into `.env` that points at the compose Postgres,
which is published on loopback only (`127.0.0.1:${POSTGRES_PORT:-5432}`; the shipped `.env` sets
5433). From the clone:

```sh
bun install
ADMIN_PASSWORD='…' bun run admin:create -- --email … --name …
```

**The password is never an argument.** `packages/auth/scripts/create-admin.ts` reads
`ADMIN_PASSWORD` or prompts for it. A password on the command line lands in the deploy user's shell
history and in `ps` output. Leave `ADMIN_PASSWORD` off and the script asks interactively, which
records nothing at all.

On a box you set up by hand, prefix the command with
`DATABASE_URL=postgres://starterdough:<POSTGRES_PASSWORD>@127.0.0.1:5433/starterdough`.

Optional services are compose profiles. Keep them in `COMPOSE_PROFILES` in `.env` rather than
passing `--profile` on the command line: `deploy.sh` runs `up --remove-orphans`, which removes the
containers of every profile that is not active in that invocation.

Builds ignore what a local run left behind. The root `.dockerignore` (and a per-service one for the
ai image, which is built with its own context) keeps `node_modules`, every `.env` at every depth
(`**/.env*`, with the tracked `.env.example` files allowed back in), `apps/native/src-tauri/target`,
build output and the uploads directory out of the build context. `apps/api/` and `packages/` are
copied into the api image's runtime stage, so a stray `apps/api/.env` would otherwise ship with the
image.

Containers run with `no-new-privileges`, `cap_drop: ALL` and a 512-pid limit (caddy adds back
`NET_BIND_SERVICE` to bind 80/443 inside the container). Postgres gets `shm_size: 1gb`: Docker's
64 MB default `/dev/shm` is where parallel-query workers put their shared memory.

### Two Caddy modes

Selected with `CADDY_MODE` in `.env`. Both Caddyfiles set the security headers (HSTS, `nosniff`,
`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`), write JSON access logs, forward one
`X-Forwarded-For` address and an `X-Request-Id`, and hold requests for up to 15 s while an
upstream restarts (active health checks on `/readyz` and `/healthz`), so a deploy is close to
seamless.

Both also do this at the edge, before anything reaches a container:

- **Bound request bodies.** 32 MB on `/uploads/*` (the local storage driver's path; it has to fit
  `MAX_UPLOAD_BYTES`, 25 MiB by default), 1 MB everywhere else, answered as `413`. Plus
  `servers { timeouts { read_header 15s; read_body 5m; idle 5m } }`. There is **no** `write`
  timeout on purpose: it would cut the `jobs.stream` SSE response mid-flight.
- **A Content-Security-Policy on the two static sites**, with `COOP`, `base-uri`,
  `object-src 'none'` and `frame-ancestors 'none'`. `connect-src` (and the docs' `form-action`)
  carry the API origin, interpolated from `API_URL`, which compose passes to the caddy container.
  The docs' policy is the looser of the two: `cdn.jsdelivr.net` for the Scalar API reference and
  `'wasm-unsafe-eval'` for pagefind's search index. Both need `'unsafe-inline'`, because Astro and
  Starlight emit inline `<script>`/`<style>` and a static header cannot carry their hashes; Astro's
  `experimental.csp` (per-page hashes) is the upgrade path. The **app** is not covered here:
  SvelteKit emits its own policy.
- **A redacted access log.** `sig` (signed upload URLs), `token`, `code`, `state` and `email` are
  deleted from the logged query string, so a live password-reset credential does not sit in
  `docker compose logs`. `X-Request-Id` still ties the entry to the API's own structured log.
- **Compression by response content type on the API** (`application/json*` only). Caddy's default
  matcher includes `text/*`, which would buffer `text/event-stream`.

| | `subdomains` (public) | `single-origin` (tailnet / LAN) |
| --- | --- | --- |
| URLs | `DOMAIN`, `docs.DOMAIN`, `app.DOMAIN`, `api.DOMAIN`; Let's Encrypt automatic | one origin: `/` app, `/api /rpc /uploads /healthz /readyz` → API, `/docs` → docs |
| DNS | four A/AAAA records → the host | none (Tailscale MagicDNS) or one LAN name |
| `.env` | `DOMAIN=your-domain.com`, `COOKIE_DOMAIN=.your-domain.com`, `WEB_URL=https://app.your-domain.com`, `API_URL=https://api.your-domain.com`, `TRUSTED_ORIGINS=https://your-domain.com,https://docs.your-domain.com`, optionally `ACME_EMAIL` | `WEB_URL=API_URL=https://<host>.<tailnet>.ts.net`, `DOCS_URL=https://<host>.<tailnet>.ts.net/docs` (leave `DOMAIN` and `COOKIE_DOMAIN` empty: one origin, no CORS) |
| TLS | Caddy | terminated upstream (Tailscale or your router); Caddy listens on plain :80 |
| Ports | 80 + 443 open (`EXPOSE=public`) | nothing open; `tailscale serve`/`funnel` reach `CADDY_HTTP_PORT` |
| Marketing site | served at `DOMAIN` | not served (the app owns `/`) |

`CADDY_BIND` is the host address those ports are published on (default `0.0.0.0`). Docker
publishes ports with its own iptables rules, bypassing ufw, so with `EXPOSE=tailscale`
`provision.sh` writes `CADDY_BIND=127.0.0.1`: `tailscale serve`/`funnel` proxy to loopback and
nothing else reaches Caddy. A LAN host that is not behind Tailscale sets it back to `0.0.0.0`.

Trusted proxies: in single-origin mode Caddy trusts `private_ranges` only, strictly
(`trusted_proxies_strict`). The hops that add `X-Forwarded-For` are `tailscaled` on the host and
Docker's bridge, both private; tailnet clients (`100.64.0.0/10`) are not proxies. The client IP the
API sees (rate limits, audit) is the real one behind `tailscale serve`/`funnel`. In the public mode
nothing is trusted.

### Your own site blocks

Both Caddyfiles end with `import /etc/caddy/conf.d/*.caddy`, and `compose.yml` mounts
`caddy/conf.d/` there. Drop a `*.caddy` file in to serve something else from the same Caddy
(another compose project, a static site, a redirect) without editing the shipped files; the
snippets (`security`, `logs`, `upstream`, `resilient`) are available to it. The directory ships
empty, and git ignores `*.caddy` in it: a drop-in is deployment configuration, like `.env`
(`git add -f` one you want versioned). Caddy warns `No files matching import glob pattern` until a
file exists. After a change:

```sh
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

To reach the containers of another compose project by name, add `compose.proxy-network.yml` to
`COMPOSE_FILE` in `.env` (its header says how). The public demo in the runbook is the worked
example.

### Tailscale: reach it from anywhere, including your phone

Install Tailscale on the server (on the host, not in a container; `provision.sh` does) and on your
devices, then:

```sh
sudo tailscale serve --bg 80     # private: only devices on your tailnet
sudo tailscale funnel --bg 80    # public: no open ports, no DNS, Let's Encrypt handled by Tailscale
```

Both give you `https://<machine>.<tailnet>.ts.net`. Use `CADDY_MODE=single-origin` with that URL as
`WEB_URL` and `API_URL`. On the phone, install the Tailscale app once; the PWA or the Tauri build
then works on the go. Alternative: Cloudflare Tunnel (`cloudflared`) for public access without
ports.

## Runbook

### Deploy, update, roll back

`.github/workflows/deploy.yml` builds the five images on every push to `main` (and `v*` tags) and
pushes them to `ghcr.io/<owner>/<repo>/{api,web,ai,caddy,backup}` tagged `sha-<commit>` plus, on
`main`, `main` and `latest`. A `v1.2.0` tag gets `sha-<commit>` and `1.2.0`; `latest` is only ever
a `main` build. Set the repository variable `DEPLOY_HOST` (+ secret `DEPLOY_SSH_KEY`, the key pair
whose public half is in the deploy user's `authorized_keys`) and it also runs
`infra/scripts/deploy.sh` on the server after each build. For a server that is only on your
tailnet, set `DEPLOY_VIA_TAILSCALE=true` plus a Tailscale OAuth client in `TS_OAUTH_CLIENT_ID` /
`TS_OAUTH_SECRET`.

```sh
# by hand, on the server (what CI runs)
IMAGE_TAG=sha-abc1234 GIT_REF=abc1234 bash infra/scripts/deploy.sh   # pull + restart + wait healthy + /readyz
bash infra/scripts/deploy.sh                                          # current checkout, IMAGE_TAG from .env
BUILD=1 bash infra/scripts/deploy.sh                                  # no registry: build on the box
```

Rollback = deploy an older tag: Actions → Deploy → Run workflow with `tag: sha-<previous>` (skips
the build), or the first command above. `deploy.sh` writes the deployed `IMAGE_TAG` back into
`.env`, so the rollback survives a later plain `docker compose up -d`. The workflow validates the
`tag` input (`[A-Za-z0-9._-]`, no leading `-`). The `pgdata` volume is never touched by a deploy.
Migrations are forward-only, so roll back code, not schema; a migration that must be undone is a
new migration.

### Backups and the restore drill

`COMPOSE_PROFILES=backup` in `.env` runs a scheduler (never `--profile` on the command line:
`deploy.sh` runs `up --remove-orphans`, which drops the containers of every profile not active in
that call). Every night at `BACKUP_SCHEDULE` (UTC) it writes `pg_dump` (custom format, compressed)
plus, with the local storage driver, a tarball of the uploads to the `backups` volume, copies both
to S3/R2 when a bucket is configured, prunes anything older than `BACKUP_RETENTION_DAYS`, and pings
`BACKUP_HEARTBEAT_URL`. Point that at a Healthchecks.io check or an Uptime Kuma push monitor and
you are alerted when backups *stop*. Details and every variable: `infra/backup/README.md`.

```sh
docker compose run --rm backup bun src/cli.ts backup                  # a backup right now (do this once, immediately)
docker compose run --rm backup bun src/cli.ts list                    # what exists (disk + bucket); exit 1 when the newest set is older than BACKUP_MAX_AGE
docker compose run --rm backup bun src/cli.ts restore latest --drill  # restore into a scratch database, verify checksum + row counts, drop it
docker compose stop api worker                                        # a real restore refuses while other sessions are connected (or pass --terminate-connections)
docker compose run --rm backup bun src/cli.ts restore <stamp> --yes
# with the uploads (see below: a different mount path, and STORAGE_DIR pointed at it)
docker compose run --rm -v starterdough_uploads:/restore/uploads -e STORAGE_DIR=/restore/uploads \
  backup bun src/cli.ts restore <stamp> --yes --uploads
docker compose start api worker
```

`BACKUP_ON_START=true` (only `true`/`1`/`false`/`0`/empty are accepted) makes the scheduler take
one backup as soon as it starts. Independently, `BACKUP_CATCHUP` (default `true`) runs one backup
at start when the newest set is older than one schedule interval, so a reboot past the nightly time
does not skip the night. `list` exits 1 when the newest restorable set is older than
`BACKUP_MAX_AGE` (36 h) or none exists. That is the command for a cron or healthcheck; pass
`--no-max-age` when browsing a recovery box.

A restore without `--yes` only prints what it would run. With `--yes` the tool first writes
`starterdough_<stamp>_pre_restore.dump` into the backups directory (`--no-safety-dump` skips it;
safety dumps are never pruned), so restoring the wrong stamp is itself recoverable. `restore latest`
picks the newest set across disk *and* bucket and logs which one won. Before touching the database
the tool loads the set's manifest, re-hashes the dump against its `sha256` (a mismatch is never
overridable; restore another set) and refuses when `manifest.database` differs from the target
(`--force-database-mismatch`) or the manifest is missing (`--no-manifest-check`). The restore runs
`--single-transaction --exit-on-error` under `BACKUP_LOCK_TIMEOUT`, so it is all-or-nothing and
cannot hang. A very large schema can hit `max_locks_per_transaction` (`out of shared memory`):
raise it, or use `--no-single-transaction` knowing a failure leaves the database half-restored.
Only one backup or restore of a database runs at a time (Postgres advisory lock).

The dump is **not encrypted** and every run says so. Encrypt the volume holding `BACKUP_DIR`, turn
on server-side encryption in the bucket, give the backup a write-only credential (`PutObject` +
`HeadObject`) with pruning by lifecycle rule, and keep object versioning on so a leaked key cannot
delete the history.

`--uploads` needs a writable uploads directory, and a `run -v` on `/data/uploads` does not give
one: Compose keeps the service's `:ro` for that target path even if the flag says `:rw`. Mount the
volume somewhere else for the one-shot and point `STORAGE_DIR` at that path (`starterdough_uploads`
is the volume's name under the compose project, `name: starterdough`). The CLI checks that the
uploads target is writable and that the archive exists before it touches the database. Unpacking
*merges* into the volume: a document deleted after that backup reappears. Wipe the volume first if
you want exactly what the archive holds. With the **S3 storage driver** no documents are backed up
at all (they never touch the box): turn on bucket versioning plus a lifecycle rule and treat that as
their backup.

Losing the whole machine: `pg_dump` captures neither the roles nor the database itself, so Postgres
must exist before anything is restored.

```sh
# 1. new box → infra/scripts/provision.sh
# 2. put back the .env you kept with the backups, and the backup files (bucket, or the `backups` volume)
docker compose up -d postgres                                          # 3. an empty `starterdough` database
docker compose run --rm backup bun src/cli.ts restore <stamp> --yes     # 4. schema + data
docker compose run --rm -v starterdough_uploads:/restore/uploads -e STORAGE_DIR=/restore/uploads \
  backup bun src/cli.ts restore <stamp> --yes --uploads                 # 5. the documents
docker compose up -d                                                   # 6. the rest of the stack
```

Every nightly run also verifies its own dump (`pg_restore --list`) and records the entry count and
a `sha256` in the manifest. Retention prunes after every attempt and at scheduler start, but never
the newest three complete sets. A failed scheduled run pings `${BACKUP_HEARTBEAT_URL}/fail`, which
Healthchecks.io and Better Stack expect. Do the drill after the first backup and then on a
calendar. Backups that stay on the same disk are not backups: set `BACKUP_S3_BUCKET` (or reuse the
uploads bucket) or copy the volume off the box. Keep the `.env` (or its SOPS copy) with the
backups: a database without its `BETTER_AUTH_SECRET` is not a restore.

### Health, logs, traces, alerting

| Signal | Where |
| --- | --- |
| Liveness | `GET /healthz` on the API and the web (process up); container health checks on api/web/ai/caddy (Dockerfile `HEALTHCHECK`s; Caddy's is a compose `healthcheck:` against its admin API). `docker compose ps` shows them. `worker` is exempt on purpose (`healthcheck: disable: true`): it runs the API image but serves no HTTP |
| Readiness | `GET /readyz` on the API (database reachable). Caddy only routes to a ready API; `deploy.sh` ends on it. The 503 body names the failing check only (`{"status":"unavailable","checks":{"database":"timeout"\|"unreachable"}}`); the reason is in the `readiness check failed` log line (`check`, `outcome`, `reason`). Simultaneous probes share one bounded `select 1`, so a hung database costs one connection however often you poll |
| Shutdown | `SIGTERM` (a deploy, `docker compose stop`): the API stops accepting, drains in-flight requests for up to 10 s, flushes telemetry (3 s cap) and closes the pool (1 s), all inside compose's 15 s `stop_grace_period`. It exits 0 even if a teardown step fails (`shutdown failed` is logged first). An unhandled rejection or uncaught exception logs `unhandled rejection` / `uncaught exception` and exits 1, which `restart: unless-stopped` turns into a restart |
| Logs | `docker compose logs -f api`: JSON lines (`LOG_FORMAT=json` in production, verbosity `LOG_LEVEL`). Every line written while a request is handled carries that request's `requestId` (matching Caddy's `X-Request-Id`), procedure calls also carry `procedure`, and `traceId` with tracing on. A 500 hands the id back as `{"error":"internal_error","requestId":…}`. All containers rotate at 10 MB × 5 |
| Traces | set `OTEL_EXPORTER_OTLP_ENDPOINT`. The `observability` profile gives you Grafana + Tempo (`http://lgtm:4318`, UI on `127.0.0.1:3030`); or Grafana Cloud / Axiom / Honeycomb with `OTEL_EXPORTER_OTLP_HEADERS`. A job and the `ai.*` calls it makes share one trace; the request that queued it is a separate trace by design (`apps/api/src/jobs/worker.ts` makes `job.run` a root span), linked through the `jobId` in the logs. Service names come from compose (`starterdough-api`, `starterdough-worker`, `starterdough-ai`), not from `.env`. Health probes (`/healthz`, `/readyz`, the AI `/health`) are not traced; query strings are stripped from span URLs |
| Uptime + alerting | `--profile monitoring`: Uptime Kuma on `127.0.0.1:${UPTIME_KUMA_PORT:-3001}` (reach it over Tailscale). A stock container, nothing is pre-configured: add monitors for `http://api:3000/readyz`, `http://web:3000/healthz`, `http://ai:8000/health`, your public URLs, and the backup heartbeat as a push monitor; notifications to mail/Slack/Telegram. External (Better Stack, Healthchecks.io) for a second vantage point |
| System page | `/admin/system` in the app: version, migrations, AI service, queue depth, storage, providers |

### Scaling and tuning

- **Jobs**: `COMPOSE_PROFILES=worker` in `.env` runs the job worker as its own container (set
  `WORKER_ENABLED=false`); `docker compose up -d --scale worker=3` adds more. The Postgres queue
  (`SKIP LOCKED`) needs no coordination.
- **Database connections**: each API/worker process holds up to `DATABASE_POOL_MAX` (10). Postgres
  allows 100. Leave headroom for `migrate` (2 while it runs: the advisory lock it takes so two
  deploys cannot migrate at once, plus the migrator itself), `backup` and your own `psql`.
- **Memory**: `compose.yml` caps api/worker/ai at 1 GB and web at 512 MB. These are caps, not
  reservations. `docker compose ps` shows OOM restarts; raise the cap rather than removing it.
- **Load test** before you guess:
  ```sh
  docker run --rm -i -e API_URL=http://<api-origin> grafana/k6 run - < infra/loadtest/k6/smoke.js
  ```
  Aim it at the API directly. The script gives each virtual user its own `X-Forwarded-For` address,
  which the API only reads with `TRUST_PROXY=true` (compose sets it on `api`). Through Caddy that
  header is replaced with the real client address, so the per-IP rate limit is what you would
  measure. For a plain throughput number use another container, for example
  `docker run --rm ghcr.io/hatoo/oha:latest -z 30s -c 50 --no-tui http://<api-origin>/healthz`.

### Secrets

Plain `.env` with `chmod 600` is what `provision.sh` writes. It is fine for one box you administer.
To version it and deploy it from CI, encrypt it with SOPS + age into `infra/env/production.enc.env`
(`/.sops.yaml`, `infra/env/README.md`). `deploy.yml` decrypts with the `SOPS_AGE_KEY` secret and
writes the server's `.env` before restarting. 1Password (`op inject`) and Doppler work the same way.

### Security notes

- Ports: Caddy publishes 80/443 on `CADDY_BIND`. Postgres is published on loopback only
  (`127.0.0.1:${POSTGRES_PORT:-5432}`, for `admin:create` and `psql` from the host). The API, the
  AI service and the worker are on the compose network. Uptime Kuma and Grafana bind to
  `127.0.0.1`. `provision.sh` sets ufw to deny inbound except the tailnet interface (and 80/443
  with `EXPOSE=public`; 22 until you remove it).
- Headers: Caddy sets the browser headers. The API sets its own (Hono `secureHeaders`) with
  `Cross-Origin-Resource-Policy: cross-origin` because `app.` and `api.` are different origins.
- CORS: only `WEB_URL` + `TRUSTED_ORIGINS` may call the API from a browser. List the site and the
  docs there in production.
- Rate limits: 300 procedure calls/min and Better Auth's own limits per client IP. The API keys them
  on the single `X-Forwarded-For` address Caddy sends only because `TRUST_PROXY=true` is set on the
  `api` service. Anything else (an empty header, a chain of hops, `TRUST_PROXY` off) falls back to
  the socket address. Never set `TRUST_PROXY` where the API port is reachable without going through
  Caddy. Determined abuse belongs at the edge (Cloudflare, fail2ban on Caddy's logs).
- Dependencies: CI runs `bun audit --prod --audit-level=high` and `pip-audit` on pushes to `main`
  and on pull requests.

### A public demo next to production

`infra/demo/` runs a second, disposable copy of the product on the same box as production, for
visitors to try before they buy. It is its own compose project (`starterdough-demo`) in its own
clone, with its own `.env` and database volume. Production is untouched, and a push to `main`
still deploys production only; the demo is updated by hand (below). Inside it
`PUBLIC_DEMO_MODE=true` is pinned by the compose file, which gives the app a banner and `noindex`
on every page.
No mail is ever sent: an empty `RESEND_API_KEY` selects the console provider, which in production
logs `NOT SENT` and drops the message, so the demo cannot burn the sending reputation of the
domain that sells the product. Hence `REQUIRE_EMAIL_VERIFICATION=false`: anyone who signs up with
any address gets an empty account straight away. No seeded accounts, no seeded data.

**How the production Caddy reaches it.** Production's Caddy owns ports 80 and 443, so the demo
has no Caddy of its own. Its `demo-web` and `demo-api` containers join a Docker network shared
with production's Caddy (`starterdough-proxy`; production joins it through
`compose.proxy-network.yml`), and a drop-in site block in `caddy/conf.d/` proxies the demo host
to them by name. No host port is published: the demo is reachable only through Caddy, and nothing
new bypasses ufw. The other option, publishing the demo on loopback ports and having Caddy proxy
to the host gateway, does not work: a port bound to `127.0.0.1` is reachable from the host only
(Docker's NAT rule matches that address and nothing else), and binding `0.0.0.0` instead would
publish the demo past the firewall. The services are called `demo-web` and `demo-api` rather
than `web` and `api` because Docker resolves a name across every network a container is on; Caddy
on both networks would find two `web`s and pick one by a rule you do not control.

**What runs.** `postgres` (its own `starterdough-demo_pgdata` volume), `migrate`, `demo-api` and
`demo-web`, from the images production runs, pulled from GHCR. No caddy (above) and no backup:
the data is disposable by design.
Limits, caps not reservations: 512 MB and 2 CPUs for the API, 256 MB and 1 CPU for the app,
512 MB and 1 CPU for Postgres. A hammered demo exhausts its own share long before production
notices.

**Bring it up**, with production already running as described above. On the box as the `deploy`
user, except where it says root.

1. DNS: an `A` record `demo` pointing at the box (`152.53.19.145`), **DNS-only** (grey cloud in
   Cloudflare), like production's records. A proxied record breaks Caddy's Let's Encrypt HTTP-01
   challenge: Cloudflare would answer the challenge URL itself and terminate TLS in front of a
   Caddy that expects to do both.
2. In the production clone (`/opt/starterdough`): the shared network, the overlay, and Caddy
   recreated on both networks.
   ```sh
   docker network create starterdough-proxy
   # in .env: COMPOSE_FILE=infra/compose.yml:infra/compose.proxy-network.yml
   docker compose up -d
   docker compose ps          # caddy healthy again; nothing else was recreated
   ```
3. Still in the production clone, the site block: write the example below to
   `infra/caddy/conf.d/demo.caddy` (git ignores it there), then
   ```sh
   docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
   docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```
   The demo host answers 502 until step 4 is done.
4. The demo clone and stack:
   ```sh
   git clone https://github.com/starterdough/starterdough-turbo.git /opt/starterdough-demo
   cd /opt/starterdough-demo
   cp infra/demo/.env.example .env && chmod 600 .env
   $EDITOR .env               # fill in the secrets: openssl rand -hex 32 for each
   docker compose pull && docker compose up -d --wait
   curl -sS https://demo.starterdough.dev/readyz
   ```
5. The nightly reset, as root:
   ```sh
   cp /opt/starterdough-demo/infra/demo/demo-reset.service /opt/starterdough-demo/infra/demo/demo-reset.timer /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now demo-reset.timer
   systemctl list-timers demo-reset.timer
   ```

The site block, `infra/caddy/conf.d/demo.caddy` in the production clone. It is
`single-origin.Caddyfile`'s routing with the demo's upstreams and without `/docs`:

```caddy
# The public demo (infra/demo): a second compose project on this box, reached over the
# starterdough-proxy network (infra/compose.proxy-network.yml). One origin: the API under its
# paths, the app everywhere else.
demo.starterdough.dev {
	import security
	import logs

	# 1 MB is plenty: every request here is a page or JSON.
	request_body {
		max_size 1MB
	}

	@api path /api/* /rpc/* /healthz /readyz
	handle @api {
		# JSON only, so a streamed response is passed through as it arrives.
		encode {
			zstd
			gzip
			match {
				header Content-Type application/json*
			}
		}
		reverse_proxy demo-api:3000 {
			import upstream
			import resilient
			health_uri /readyz
			flush_interval -1
		}
	}

	handle {
		encode zstd gzip
		reverse_proxy demo-web:3000 {
			import upstream
			import resilient
			health_uri /healthz
		}
	}
}
```

**Reset.** `bash infra/demo/reset.sh` from the demo clone, by hand at any time; the timer runs it
every night at 04:00 UTC. It stops `demo-web` and `demo-api`, drops the database and creates it
again, and `docker compose up -d --wait` runs the migrations and starts everything: the demo is
empty, and answers 502 for about 30 s in between. Idempotent: a second run does the same again.
Whoever is signed in at that moment loses the session and the account: the next request answers
401, the app shows sign-in, and they sign up again into an empty account.

The guard is the stack's identity, not a flag: the compose project resolved from the current
`.env` must be named `starterdough-demo` and have a `demo-api` service, and that service's
container must run with `PUBLIC_DEMO_MODE=true`. Anything else, including a run from the
production clone, prints why and exits 1 before the first write. Daily because a visitor's
address and whatever they typed then live on the box for at most a day, while everyone still gets
a day to explore; change it with `systemctl edit demo-reset.timer` (`OnCalendar=`, explained in
the timer file). `journalctl -u demo-reset` shows what each run did.

**Update.** Production's deploy never touches the demo. In the demo clone:
`git pull && docker compose pull && docker compose up -d --wait` (the pull of the clone for the
compose file and the migrations, the pull of the images for the code).

**Take it down.** In the demo clone `docker compose down` (keeps the volume) or
`docker compose down -v` (wipes it); as root `systemctl disable --now demo-reset.timer`; in the
production clone delete `infra/caddy/conf.d/demo.caddy` and `caddy reload` as above. The overlay
row and the network can stay or go: remove the row from `COMPOSE_FILE`, `docker compose up -d`,
`docker network rm starterdough-proxy`.

**Its own box later.** On a box of its own the demo is the ordinary self-hosted stack:
`provision.sh` with `EXPOSE=public`, the demo `.env` values on top of the generated `.env`
(`PUBLIC_DEMO_MODE=true`, `REQUIRE_EMAIL_VERIFICATION=false`, an empty `RESEND_API_KEY`, no keys)
with `DOMAIN=demo.starterdough.dev`, and the DNS records pointed at that box. Nothing from this
section is needed there: no drop-in, no shared network, no `infra/demo/compose.yml`. Two things
are not just a `DOMAIN` change. `compose.yml` has no single-origin mode with its own TLS
(`single-origin` expects Tailscale or a router in front), so the demo takes the subdomain layout
there, `app.demo.starterdough.dev` and `api.demo.starterdough.dev`, and the web image must be
built for that API origin (`BUILD=1 bash infra/scripts/deploy.sh`, or CI variables of its own),
because its Content-Security-Policy is baked at build time. And `reset.sh` refuses there by
design (the project is `starterdough`, not the demo): the reset on that box is
`docker compose down -v && docker compose up -d --wait`, on the same timer.

### Troubleshooting

| Symptom | Look at |
| --- | --- |
| Caddy serves `localhost` / certificates for the wrong names | you ran compose with `-f` and no `--env-file`; run it from the root (see top) |
| `api` restarts, `migrate` exited non-zero | `docker compose logs migrate`; usually `DATABASE_URL`/`POSTGRES_PASSWORD` changed after the volume was created |
| 502 for ~15 s after a deploy, then fine | expected worst case; the API took long to become ready. `docker compose logs api` |
| `/readyz` 503 | Postgres down or out of connections: `docker compose ps postgres`, `docker compose exec postgres psql -U starterdough -c 'select count(*) from pg_stat_activity'`. The body only says `timeout` or `unreachable`; `docker compose logs api \| grep 'readiness check failed'` has the reason |
| Uploads fail in single-origin mode | `/uploads/*` must reach the API (it does in the shipped Caddyfile); `MAX_UPLOAD_BYTES` |
| Jobs stuck `queued` | no worker: `WORKER_ENABLED=false` without `--profile worker`; AI service down: they retry, then refund |
| No traces | `OTEL_EXPORTER_OTLP_ENDPOINT` unset in `.env`, or the collector needs `OTEL_EXPORTER_OTLP_HEADERS` |
| `docker compose pull` denied | private GHCR packages: `docker login ghcr.io` with a token that has `read:packages`, or make the packages public |

## Cloudflare notes

- Astro sites: static assets on Workers (`wrangler.jsonc` in `apps/site`, `apps/docs`).
- SvelteKit: `ADAPTER=cloudflare` selects `@sveltejs/adapter-cloudflare` (Workers static assets +
  SSR).
- The API stays on a container host: it uses Bun-native `Bun.SQL`, long-lived Postgres connections
  and Better Auth's full feature set, which do not fit Workers well. To run the API at the edge, use
  Hyperdrive for Postgres pooling and swap `drizzle-orm/bun-sql` for `drizzle-orm/postgres-js`.

## Jobs, uploads and the AI service

- **Background jobs** run inside the `api` container (`WORKER_ENABLED=true`, the default). To scale
  them separately, add `worker` to `COMPOSE_PROFILES` and set `WORKER_ENABLED=false` in `.env`, so
  the API replicas leave the queue to the `worker` service. Any number of workers can share the
  queue.
- **Uploaded documents** live on the `uploads` volume when `S3_BUCKET` is unset (the API serves
  them itself through signed URLs) and are included in the nightly backup. For Cloudflare R2 / S3 /
  MinIO set `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
  Browsers then upload and download straight from the bucket, so its CORS rules must allow the web
  origin (`PUT`, `GET`, header `Content-Type`).
