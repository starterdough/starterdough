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
compose.yml               the production stack (postgres, migrate, api, web, caddy, backup*, uptime-kuma*, lgtm*)   * = profile
compose.dev.yml           Postgres for local development (`bun run db:up`)
caddy/                    subdomains.Caddyfile (public domain) · single-origin.Caddyfile (tailnet / LAN)
caddy/conf.d/             your own site blocks, imported by both Caddyfiles (ships empty; README inside)
compose.proxy-network.yml optional overlay: caddy joins a network shared with other compose projects
demo/                     a public demo next to production: compose file, .env template, its two
                          Caddyfiles, reset script + timer, update script run by every deploy
docker/Dockerfile.static  builds apps/site + apps/docs (your product's docs unless DOCS_CONTENT=kit) into the Caddy image
backup/                   pg_dump to a volume and S3/R2, retention, restore drill (its own README)
scripts/provision.sh      one-time VPS setup: Docker, Tailscale, deploy user, firewall, clone, .env with secrets
scripts/deploy.sh         pull a tag, release backup, restart, wait for health, readiness check. CI runs this over SSH
scripts/hooks/            your own pre-deploy and post-deploy scripts, which deploy.sh runs (README inside)
scripts/ops.sh            what the Server status, logs, backup and Admin bootstrap workflows run on the server
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
# new server: Docker, Tailscale, Python, flock, a `deploy` user, ufw, unattended upgrades, the clone, .env with fresh secrets
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/infra/scripts/provision.sh \
  | sudo REPO_URL=https://github.com/<owner>/<repo>.git EXPOSE=tailscale bash     # or EXPOSE=public
# from a private repository: copy provision.sh to the box and pass GIT_TOKEN (the top of the script shows how)

su - deploy                        # or: sudo -iu deploy
cd /opt/starterdough
$EDITOR .env                       # DOMAIN (public) or WEB_URL/API_URL for a tailnet host (below);
                                   # provision.sh already set CADDY_MODE and generated the secrets
docker compose up -d --build       # or, for the images CI pushed: see "prebuilt images" below
docker compose ps                  # every service healthy; `migrate` exited 0
```

Three rows ship **empty on purpose**. A plausible value would produce a stack that looks healthy
and is wrong:

- `DOMAIN`: empty means `localhost` and Caddy's internal CA. Fill it in for the public mode.
- `IMAGE_REGISTRY`: empty means the local `starterdough/<name>:<tag>` namespace, so
  `docker compose pull` fails with "pull access denied" instead of fetching a stranger's build.
- `COOKIE_DOMAIN`: a bare hostname, never a URL. The browser silently drops a cookie whose `Domain=`
  is a URL and sign-in appears to work.

`POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET` are required (`${VAR:?…}` in `compose.yml`).
`.env.example` ships them empty and compose stops with `set … in .env` rather than starting the
stack on a placeholder. `provision.sh` generates both. In production the API also refuses any
`change-me…` secret and a `DATABASE_URL` whose password is `starterdough`, `postgres` or
`change-me…`. Generate every value you fill in yourself:

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

Migrations run automatically. The `migrate` service applies the kit's migrations
(`packages/db/drizzle`), then yours (`packages/db/drizzle-product`), and `api` only starts once it
has exited successfully. Every `docker compose up` repeats that (a no-op when nothing is pending).

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

Builds ignore what a local run left behind. The root `.dockerignore` keeps `node_modules`, every
`.env` at every depth (`**/.env*`, with the tracked `.env.example` files allowed back in),
`apps/native/src-tauri/target` and build output out of the build context. `apps/api/` and
`packages/` are copied into the api image's runtime stage, so a stray `apps/api/.env` would
otherwise ship with the image.

Containers run with `no-new-privileges`, `cap_drop: ALL` and a 512-pid limit. Both Caddy services
add `NET_BIND_SERVICE` back: the image's binary carries that file capability, and the kernel
refuses to execve a file whose permitted set is not inside the bounding set, so without it the
container fails at `exec` whatever ports it binds. Postgres gets `shm_size: 1gb`: Docker's
64 MB default `/dev/shm` is where parallel-query workers put their shared memory.

### Two Caddy modes

Selected with `CADDY_MODE` in `.env`. Both Caddyfiles set the security headers (HSTS, `nosniff`,
`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`), write JSON access logs, forward one
`X-Forwarded-For` address and an `X-Request-Id`, and hold requests for up to 15 s while an
upstream restarts (active health checks on `/readyz` and `/healthz`), so a deploy is close to
seamless.

Both also do this at the edge, before anything reaches a container:

- **Bound request bodies.** 1 MB, answered as `413`. Plus
  `servers { timeouts { read_header 15s; read_body 5m; idle 5m } }`. There is **no** `write`
  timeout on purpose: it would cut a server-sent event stream mid-flight.
- **A Content-Security-Policy on the two static sites**, with `COOP`, `base-uri`,
  `object-src 'none'` and `frame-ancestors 'none'`. `connect-src` (and the docs' `form-action`)
  carry the API origin, interpolated from `API_URL`, which compose passes to the caddy container.
  The docs' policy is the looser of the two: `cdn.jsdelivr.net` for the Scalar API reference and
  `'wasm-unsafe-eval'` for pagefind's search index. Both need `'unsafe-inline'`, because Astro and
  Starlight emit inline `<script>`/`<style>` and a static header cannot carry their hashes; Astro's
  `experimental.csp` (per-page hashes) is the upgrade path. The **app** is not covered here:
  SvelteKit emits its own policy.
- **A redacted access log.** `sig`, `token`, `code`, `state` and `email` are deleted from the
  logged query string, so a live password-reset credential does not sit in `docker compose logs`.
  `X-Request-Id` still ties the entry to the API's own structured log.
- **Compression by response content type on the API** (`application/json*` only). Caddy's default
  matcher includes `text/*`, which would buffer `text/event-stream`.

| | `subdomains` (public) | `single-origin` (tailnet / LAN) |
| --- | --- | --- |
| URLs | `DOMAIN`, `docs.DOMAIN`, `app.DOMAIN`, `api.DOMAIN`; Let's Encrypt automatic | one origin: `/` app, `/api /rpc /healthz /readyz` → API, `/docs` → docs |
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

Day-to-day operation needs no shell on the server: the Deploy workflow releases, and the ops
workflows ("Operate without a shell" below) inspect, back up and recover. What still needs one,
and the way in to prepare for it before it does, is in the docs' "Server access and break glass"
(`apps/docs/src/content/docs/guides/server-access.md`), together with the case for one product per
server.

### Deploy, update, roll back

`.github/workflows/deploy.yml` is **off until you switch it on**. In a new repository a push runs CI
and nothing else, so the first push cannot go red over a server you have not set up yet. Once it is
on, production follows CI: when CI passes for a push to `main`, the workflow builds the images
behind `infra/compose.yml` from that exact commit, pushes them to `ghcr.io/<owner>/<repo>/<name>`
tagged `sha-<commit>`, `main` and `latest`, then delivers the commit to the server and runs
`infra/scripts/deploy.sh` there. A commit whose CI fails is never built or deployed, and neither is
one `main` has already moved past. A `v1.2.0` tag builds images tagged `sha-<commit>` and `1.2.0`
and deploys nothing; `latest` is only ever a `main` build.

The one-time setup, in this order:

1. **The server.** `provision.sh`, above. From a private repository, copy the script to the box
   and pass `GIT_TOKEN` for the first clone (the top of the script shows how); nothing needs that
   token afterwards. Then make a key pair for CI and authorize its public half for the deploy user
   (`provision.sh` gave that user root's keys, so your own login works for this):
   ```sh
   ssh-keygen -t ed25519 -N '' -C starterdough-ci -f starterdough-ci     # on your machine
   ssh-copy-id -i starterdough-ci.pub deploy@<host>
   ```
2. **Variables** (Settings → Secrets and variables → Actions → Variables): `SITE_URL`, `DOCS_URL`,
   `WEB_URL` and `API_URL`, which are baked into the images (the build names any that is missing),
   `DEPLOY_HOST`, and the two values `provision.sh` printed last: `DEPLOY_PATH`, the checkout on
   the server, which has no default, and `DEPLOY_KNOWN_HOSTS`, the server's SSH host key. Every
   workflow that reaches the server refuses any other key. For a box `provision.sh` did not set up,
   compare `ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -` with
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the box or in your provider's console,
   and once they match, use the line `ssh-keyscan -t ed25519 <host>` prints. `DEPLOY_USER` only if
   you changed `provision.sh`'s default, `COMPOSE_PROJECT_NAME` only if the server's `.env`
   renames the Compose project, and `DEPLOY_VIA_TAILSCALE=true` for a server that is only on your
   tailnet.
3. **Secrets** (the same page, Secrets tab): `DEPLOY_SSH_KEY`, the private half
   (`starterdough-ci`). Optional: `SOPS_AGE_KEY` (see "Secrets" below), `GHCR_PULL_TOKEN`, and a
   Tailscale OAuth client in `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` with `DEPLOY_VIA_TAILSCALE`.
   For Admin bootstrap, `ADMIN_BOOTSTRAP_PASSWORD` as a secret of the `production` environment
   (Settings → Environments), at least 12 characters; delete it after the first sign-in.
4. **No deploy key.** The server never fetches from GitHub: the workflow pushes the commit it
   releases into the server's checkout over the same SSH login. The box holds no credential for
   your repository, so there is nothing to add on GitHub, store on the server or rotate.
5. **Switch it on** with the variable `DEPLOY_ENABLED=true`. The next push to `main` deploys once CI
   passes; to deploy the current `main` straight away, Actions → Deploy → Run workflow.

`DEPLOY_ENABLED=true` without `DEPLOY_HOST` builds and pushes the images and deploys nothing, for a
host that pulls them itself. To have a person approve every release, add required reviewers to the
`production` environment (Settings → Environments); the deploy job waits for them, and so do the
ops workflows.

Every deploy, in order:

1. **Checks the server** before it changes anything: the host key against `DEPLOY_KNOWN_HOSTS`,
   the server's clock (more than 30 s off the runner's fails the job: two-factor codes and S3
   signatures depend on it), no pending recovery journal, and a checkout that shares history with
   the release and runs this product's Compose project (with `DEMO_PATH` set, a demo checkout that
   runs the demo's). Only then does it replace the server's `.env` from SOPS and check out the
   release. With `DEMO_PATH` set, it moves the demo onto the release first ("A public demo" below).
2. **Pulls the images** and runs your pre-deploy hooks (`scripts/hooks/README.md`).
3. **Takes a release backup**: `backup --release`, a dump of the database only, into the `backups`
   volume under `release/`, the newest four kept, never copied off the box or reported to the
   heartbeat. It is the restore point for this release's migrations. It waits up to 10 minutes for
   a nightly backup that is running, and a first deploy, whose database has no tables yet, skips
   it. `RELEASE_BACKUP=off` in `.env` turns it off, for a box with provider snapshots or a database
   too large to dump on every deploy. Anything that fails up to here leaves production on its
   current release, with no journal.
4. **Stops the writers, migrates and starts the release** (the recovery journal below covers an
   interruption), then checks `/readyz` from inside the API container.
5. **Tidies up**: keeps the three newest local builds of each image and drops the rest, runs your
   post-deploy hooks, and fetches `API_URL/readyz` and `WEB_URL` from the runner
   (`SMOKE_TEST=off` skips that, for a site the runner cannot reach).

The deploy job is cancelled after 180 minutes. That ceiling covers the worst legitimate case (three
30-minute waits for the host lock, the demo's update, the release backup's wait and its 30-minute
ceiling, Compose's start), so reaching it means something hung; an interrupted rollout is what
"Recover an interrupted deployment" below is for.

`.github/workflows/registry-cleanup.yml` keeps GHCR from growing by a set of images per release:
every week, while `DEPLOY_ENABLED` is on, it deletes all but the version tags, `latest`, `main` and
the 20 newest other builds of each image. Run it by hand with `dry-run` first. Desktop installers
(`.github/workflows/desktop.yml`) build on a `v*` tag only once the variable `DESKTOP_ENABLED` is
`true`.

```sh
# by hand, on the server (what CI runs)
IMAGE_TAG=sha-abc1234 GIT_REF=abc1234 bash infra/scripts/deploy.sh   # pull + restart + wait healthy + /readyz
bash infra/scripts/deploy.sh                                          # current checkout, IMAGE_TAG from .env
BUILD=1 bash infra/scripts/deploy.sh                                  # no registry: build on the box
```

Rollback = deploy an older tag: Actions → Deploy → Run workflow with `tag: sha-<previous>` (skips
the build), or the first command above. GHCR keeps the 20 newest builds of each image (above);
roll back further than that by version tag. A run by hand deploys only a commit that passed CI on a
push to `main`, and refuses anything else before it builds or touches the server. The first command
needs no access to the repository for a commit the workflow delivered, which is already in the
checkout; any other commit is fetched from `origin`, and on a private repository that needs a
credential on the box. `deploy.sh` writes the deployed `IMAGE_TAG` back into `.env`, so the
rollback survives a later plain `docker compose up -d`. The workflow validates the `tag` input
(`[A-Za-z0-9._-]`, no leading `-`). The `pgdata` volume is never touched by a deploy.
Migrations are forward-only. Check release compatibility before rolling back code; a migration
that must be undone requires a new migration, or restoring the release set the deploy took
(below, and "When a deploy fails" in the server access guide).

### Recover an interrupted deployment

Deploys, demo updates, and demo resets share a host operation lock. Before a deploy stops an API
writer, it writes a private journal at
`~/.local/state/starterdough/deployment-interrupted`; set `STARTERDOUGH_STATE_DIR` to use a
different state directory. The journal contains only the checkout path, revision, configuration
digest, image identities, and exact prior containers. It never records environment values.

If a rollout is interrupted, use **Actions → Recover deployment**. Run `status` for the affected
`production` or `demo` checkout first, then `recover`. It runs even while `DEPLOY_ENABLED` is off,
so switching deploys off in an incident does not lock you out. The same operations can be run on
the server:

```sh
bash infra/scripts/recover-deployment.sh status
bash infra/scripts/recover-deployment.sh recover
bash infra/scripts/recover-deployment.sh abandon <first 7 characters of the revision>
```

Recovery follows the phase recorded before interruption:

| Recorded phase | Recovery action |
| --- | --- |
| `pre-replacement` | Validate and restart only the recorded prior writer containers. |
| `forward-only` | Validate the staged release, then resume its local Compose startup and migrations. |

The forward-only phase is persisted before Compose can start a migration. Once it is recorded,
recovery never restarts the old release because its schema may be incompatible. A deploy that
finds no old API running (a first boot, or a release whose API never came up) records that phase
from the start, since there is nothing to revive.
Changed configuration, checkout, or image identities make recovery refuse instead of guessing.
Recovery does not fetch, check out, pull, or build.

The journal remains until recovery passes readiness. New deploys and demo resets refuse while it
exists. A rollback to a commit from before these recovery helpers also refuses before
containers are changed; deploy a release that includes the safeguards or use the explicit recovery
workflow first. New hosts receive `python3` and `flock` from `provision.sh`; install both on
existing hosts before their first recovery-aware deployment.

A migration that fails every time would keep the journal there for good: `recover` only runs it
again, and the journal blocks the deploy of the fix too. `abandon` drops a forward-only journal
and starts or stops nothing. It needs the first 7 characters of the revision `status` printed (the
workflow's `confirm` input) and runs only in the recorded checkout. Then deploy the fix or the
previous tag. If the migration ran and damaged data, first restore the release set with the
writers stopped (`docker compose run --rm backup bun src/cli.ts restore <stamp> --release --yes`),
then abandon and deploy the previous tag. The restore leaves the database holding exactly what the
set holds, so a later release runs the migration again from the start. A journal that a 1.0.0
deploy wrote is recovered by the 1.0.0 scripts in its checkout, which have no `abandon`; the server
access guide says how to drop one by hand.

### Operate without a shell

Four more workflows, run from Actions → the workflow → Run workflow, do what would otherwise take an
SSH session. They ship `scripts/ops.sh` from the runner on every run, so they work against a
checkout of any age:

| Workflow | What it does | Lock |
| --- | --- | --- |
| Server status | containers, disk, memory, the deployment journal, the server's host key fingerprint and the last lines of the API containers' logs, for production or the demo | none: it only reads |
| Server logs | one service's logs, the last 100 to 10,000 lines, optionally since a time | none: it only reads |
| Server backup | `backup`, `list` or `drill`, of the nightly sets or the release sets, on production | the host lock, waiting up to 10 minutes |
| Admin bootstrap | `admin:create` inside the running API container, with the password from the environment secret `ADMIN_BOOTSTRAP_PASSWORD` on its standard input, or `promote` for an existing account | the host lock; refused while a recovery journal is pending |

Like Deploy, they run only while `DEPLOY_ENABLED` is `true`, use its variables and secret, and run
in the `production` environment, whose required reviewers approve them too. Each first checks that
the checkout it reaches runs the expected Compose project (`COMPOSE_PROJECT_NAME`, or the `name:`
in `compose.yml` or `demo/compose.yml`), so a `DEPLOY_PATH` or `DEMO_PATH` that names another
product's checkout is refused before anything runs. A live restore is deliberately not offered.
Everyone who can read the repository can read a run's log: in a public repository Server logs
refuses to run and Server status leaves the log lines out, and Admin bootstrap's log shows the
address you entered.

### Backups and the restore drill

`COMPOSE_PROFILES=backup` in `.env` runs a scheduler (never `--profile` on the command line:
`deploy.sh` runs `up --remove-orphans`, which drops the containers of every profile not active in
that call). Every night at `BACKUP_SCHEDULE` (UTC) it writes `pg_dump` (custom format, compressed)
to the `backups` volume, copies it to S3/R2 when a bucket is configured, prunes anything older than
`BACKUP_RETENTION_DAYS`, and pings `BACKUP_HEARTBEAT_URL`. Point that at a Healthchecks.io check or
an Uptime Kuma push monitor and you are alerted when backups *stop*. Details and every variable:
`infra/backup/README.md`.

```sh
docker compose run --rm backup bun src/cli.ts backup                  # a backup right now (do this once, immediately)
docker compose run --rm backup bun src/cli.ts list                    # what exists (disk + bucket); exit 1 when the newest set is older than BACKUP_MAX_AGE
docker compose run --rm backup bun src/cli.ts restore latest --drill  # restore into a scratch database, verify checksum + row counts, drop it
docker compose run --rm backup bun src/cli.ts list --release          # the restore points deploys took (add --release to restore, too)
docker compose stop api                                               # a real restore refuses while other sessions are connected (or pass --terminate-connections)
docker compose run --rm backup bun src/cli.ts restore <stamp> --yes
docker compose start api
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
(`--force-database-mismatch`) or the manifest is missing (`--no-manifest-check`). The restore clears
the database and runs the set in one transaction (`--single-transaction --exit-on-error`) under
`BACKUP_LOCK_TIMEOUT`, so it is all-or-nothing, cannot hang, and leaves the database holding exactly
what the set holds. A very large schema can hit `max_locks_per_transaction` (`out of shared
memory`): raise it, or use `--no-single-transaction` knowing a failure leaves the database
half-restored.
Only one backup or restore of a database runs at a time (Postgres advisory lock). A scheduled
backup waits up to 30 minutes for it and a deploy's release backup up to 10, so the two never fail
each other; a manual backup and every restore refuse at once.

**Release sets** are the restore points `deploy.sh` takes before each release's migrations
("Deploy, update, roll back" above): the database only, in the `backups` volume under `release/`,
on this box only, the newest four kept. `list --release` and `restore … --release` work on them,
and the Server backup workflow lists, drills or takes one without a shell. A release set holds
nothing written after its deploy began, so restoring one after the new release has served traffic
loses that traffic's writes.

The dump is **not encrypted** and every run says so. Encrypt the volume holding `BACKUP_DIR`, turn
on server-side encryption in the bucket, give the backup a write-only credential (`PutObject` +
`HeadObject`) with pruning by lifecycle rule, and keep object versioning on so a leaked key cannot
delete the history.


Losing the whole machine: `pg_dump` captures neither the roles nor the database itself, so Postgres
must exist before anything is restored.

```sh
# 1. new box → infra/scripts/provision.sh
# 2. put back the .env you kept with the backups, and the backup files (bucket, or the `backups` volume)
docker compose up -d postgres                                          # 3. an empty `starterdough` database
docker compose run --rm backup bun src/cli.ts restore <stamp> --yes     # 4. schema + data
docker compose up -d                                                   # 5. the rest of the stack
```

Every nightly run also verifies its own dump (`pg_restore --list`) and records the entry count and
a `sha256` in the manifest. Retention prunes after every attempt and at scheduler start, but never
the newest three complete sets. A failed scheduled run pings `${BACKUP_HEARTBEAT_URL}/fail`, which
Healthchecks.io and Better Stack expect. Do the drill after the first backup and then on a
calendar. Backups that stay on the same disk are not backups: set `BACKUP_S3_BUCKET` or copy the
volume off the box. Keep the `.env` (or its SOPS copy) with the backups: a database without its
`BETTER_AUTH_SECRET` is not a restore.

### Health, logs, traces, alerting

| Signal | Where |
| --- | --- |
| Liveness | `GET /healthz` on the API and the web (process up); container health checks on api/web/caddy (Dockerfile `HEALTHCHECK`s; Caddy's is a compose `healthcheck:` against its admin API). `docker compose ps` shows them |
| Readiness | `GET /readyz` on the API (database reachable). Caddy only routes to a ready API; `deploy.sh` ends on it. The 503 body names the failing check only (`{"status":"unavailable","checks":{"database":"timeout"\|"unreachable"}}`); the reason is in the `readiness check failed` log line (`check`, `outcome`, `reason`). Simultaneous probes share one bounded `select 1`, so a hung database costs one connection however often you poll |
| Shutdown | `SIGTERM` (a deploy, `docker compose stop`): the API stops accepting, drains in-flight requests for up to 10 s, flushes telemetry (3 s cap) and closes the pool (1 s), all inside compose's 15 s `stop_grace_period`. It exits 0 even if a teardown step fails (`shutdown failed` is logged first). An unhandled rejection or uncaught exception logs `unhandled rejection` / `uncaught exception` and exits 1, which `restart: unless-stopped` turns into a restart |
| Logs | `docker compose logs -f api`: JSON lines (`LOG_FORMAT=json` in production, verbosity `LOG_LEVEL`). Every line written while a request is handled carries that request's `requestId` (matching Caddy's `X-Request-Id`), procedure calls also carry `procedure`, and `traceId` with tracing on. A 500 hands the id back as `{"error":"internal_error","requestId":…}`. All containers rotate at 10 MB × 5 |
| Traces | set `OTEL_EXPORTER_OTLP_ENDPOINT`. The `observability` profile gives you Grafana + Tempo (`http://lgtm:4318`, UI on `127.0.0.1:3030`); or Grafana Cloud / Axiom / Honeycomb with `OTEL_EXPORTER_OTLP_HEADERS`. Service names come from compose (`starterdough-api`), not from `.env`. Health probes (`/healthz`, `/readyz`) are not traced; query strings are stripped from span URLs |
| Errors | `SENTRY_DSN` in `.env`: the web container's server side and the API report unexpected errors to one Sentry project. Errors only (traces stay with OpenTelemetry), and a failed query's statement and parameters are withheld |
| Uptime + alerting | `--profile monitoring`: Uptime Kuma on `127.0.0.1:${UPTIME_KUMA_PORT:-3001}` (reach it over Tailscale). A stock container, nothing is pre-configured: add monitors for `http://api:3000/readyz`, `http://web:3000/healthz`, your public URLs, and the backup heartbeat as a push monitor; notifications to mail/Slack/Telegram. External (Better Stack, Healthchecks.io) for a second vantage point |
| System page | `/admin/system` in the app: version, migrations, providers |

Everything on that list but the errors runs on the box, and goes quiet with it. Watch it from
outside as well:

- an external uptime check (Better Stack, Healthchecks.io or UptimeRobot) on `API_URL/readyz` and
  `WEB_URL`, which alerts when the box, its network or Caddy is down;
- a Healthchecks.io check with a period of 1 day and a grace of 12 hours, its ping URL in
  `BACKUP_HEARTBEAT_URL`: a night without a backup pages you, and a failed run's `/fail` ping pages
  at once;
- optionally, logs shipped off the box, since they rotate away at 10 MB × 5 per container: Grafana
  Alloy or Vector reading Docker's json-file logs into Loki, Grafana Cloud or Better Stack, or
  Docker's `loki` logging driver, which keeps `docker compose logs` working through dual logging.

### Scaling and tuning

- **Database connections**: each API process holds up to `DATABASE_POOL_MAX` (10). Postgres allows
  100. Leave headroom for `migrate` (2 while it runs: the advisory lock it takes so two deploys
  cannot migrate at once, plus the migrator itself), `backup` and your own `psql`.
- **Memory**: `compose.yml` caps api at 1 GB and web at 512 MB. These are caps, not reservations.
  `docker compose ps` shows OOM restarts; raise the cap rather than removing it.
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
  (`127.0.0.1:${POSTGRES_PORT:-5432}`, for `admin:create` and `psql` from the host). The API is on
  the compose network. Uptime Kuma and Grafana bind to `127.0.0.1`. `provision.sh` sets ufw to deny
  inbound except the tailnet interface (and 80/443 with `EXPOSE=public`; 22 until you remove it).
- Headers: Caddy sets the browser headers. The API sets its own (Hono `secureHeaders`) with
  `Cross-Origin-Resource-Policy: cross-origin` because `app.` and `api.` are different origins.
- CORS: only `WEB_URL` + `TRUSTED_ORIGINS` may call the API from a browser. List the site and the
  docs there in production.
- CSRF: every `/rpc` call must carry the `x-csrf-token` header the shared client sends, and a
  cookie-carrying write to `/api/v1` from an origin outside that same list answers
  `403 forbidden_origin`. It backs up the `SameSite=Lax` session cookie against pages on a sibling
  subdomain, which count as the same site.
- Rate limits: 300 procedure calls/min and Better Auth's own limits per client IP. The API keys them
  on the single `X-Forwarded-For` address Caddy sends only because `TRUST_PROXY=true` is set on the
  `api` service. Anything else (an empty header, a chain of hops, `TRUST_PROXY` off) falls back to
  the socket address. Never set `TRUST_PROXY` where the API port is reachable without going through
  Caddy. Determined abuse belongs at the edge (Cloudflare, fail2ban on Caddy's logs).
- Pinning: every workflow checks the server's SSH host key against `DEPLOY_KNOWN_HOSTS`, never
  trusting a first key, and refuses a checkout that runs another Compose project. Every action is
  pinned to a commit and every base and service image to a patch release
  (`scripts/image-pins.test.ts`), so a rebuild changes nothing until a reviewed commit does.
- Backup credentials: `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` and
  `BACKUP_HEARTBEAT_URL` reach the `backup` service only. `compose.yml` blanks them for every
  service built from the API image, so an application process never holds a key that could delete
  its own recovery copies; CI checks it (`scripts/compose-secrets.test.py`).
- Ops logs: an Actions run's log is readable by everyone who can read the repository. In a public
  repository Server logs refuses to run and Server status leaves out the log lines, which carry
  client addresses, paths and ids.
- Dependencies: CI runs `bun audit --prod --audit-level=high` on pushes to `main` and on pull
  requests.

### A public demo next to production

`infra/demo/` runs a second, disposable copy of the product on the same box as production, for
visitors to try before they buy. It is its own compose project (`starterdough-demo`) in its own
clone, with its own `.env` and database volume. Nothing in it touches production, and every
deploy of production moves the demo onto the same build (below). Inside it
`PUBLIC_DEMO_MODE=true` is pinned by the compose file, which gives the app a banner and `noindex`
on every page; the marketing site and the docs come out of an Astro build that knows nothing about
the demo, so they are kept out of search results by an `X-Robots-Tag` header instead.
No mail is ever sent: an empty `RESEND_API_KEY` selects the console provider, which in production
logs `NOT SENT` and drops the message, so the demo cannot burn the sending reputation of the
domain that sells the product. Hence `REQUIRE_EMAIL_VERIFICATION=false`: anyone who signs up with
any address gets an empty account straight away. No seeded accounts, no seeded data.

**How the production Caddy reaches it.** Production's Caddy owns ports 80 and 443, so the demo
terminates no TLS and answers on no hostname of its own. Its `demo-web`, `demo-api` and
`demo-static` containers join a Docker network shared with production's Caddy
(`starterdough-proxy`; production joins it through `compose.proxy-network.yml`), and two drop-in
site blocks in `caddy/conf.d/` proxy the demo's two hosts to them by name. No host port is published: the demo is reachable only through Caddy, and nothing
new bypasses ufw. The other option, publishing the demo on loopback ports and having Caddy proxy
to the host gateway, does not work: a port bound to `127.0.0.1` is reachable from the host only
(Docker's NAT rule matches that address and nothing else), and binding `0.0.0.0` instead would
publish the demo past the firewall. The services are called `demo-web`, `demo-api` and
`demo-static` rather than `web`, `api` and `caddy` because Docker resolves a name across every
network a container is on; Caddy on both networks would find two `web`s and pick one by a rule you
do not control.

**What runs.** `postgres` (its own `starterdough-demo_pgdata` volume), `migrate`, `demo-api` and
`demo-web`, from the images production runs, pulled from GHCR, and `demo-static`, which serves the
marketing site on :8080 and the docs on :8081. CI builds that last image separately for the demo:
`Dockerfile.static` compiles `SITE_URL`, `DOCS_URL`, `PUBLIC_APP_URL` and `PUBLIC_API_URL` into
every page, so production's `caddy` image would serve the demo a site whose every link points at
production. Routine deploys pull it instead of compiling on the VPS. No backup: the data is
disposable by design.
Limits, caps not reservations: 512 MB and 2 CPUs for the API, 256 MB and 1 CPU each for the app
and the static server, 512 MB and 1 CPU for Postgres. A hammered demo exhausts its own share long
before production notices.

**Bring it up**, with production already running as described above. On the box as the `deploy`
user, except where it says root.

1. DNS: two `A` records, `demo` and `app.demo`, pointing at the box (`192.0.2.10`),
   **DNS-only** (grey cloud in Cloudflare), like production's records. A proxied record breaks
   Caddy's Let's Encrypt HTTP-01 challenge: Cloudflare would answer the challenge URL itself and
   terminate TLS in front of a Caddy that expects to do both.
2. In the production clone (`/opt/starterdough`): the shared network, the overlay, and Caddy
   recreated on both networks.
   ```sh
   docker network create starterdough-proxy
   # in .env: COMPOSE_FILE=infra/compose.yml:infra/compose.proxy-network.yml
   docker compose up -d
   docker compose ps          # caddy healthy again; nothing else was recreated
   ```
3. Still in the production clone, the site blocks. The demo ships them ready to copy in, and
   `conf.d` keeps `*.caddy` out of git, so this is a copy and not a commit. `DEMO_DOMAIN` has no
   default: while it is unset the drop-in is a keyless site block and Caddy refuses the whole
   config, which is what keeps a half-configured demo from taking production's Caddy with it.
   ```sh
   cp infra/demo/caddy/demo.caddy infra/caddy/conf.d/demo.caddy
   # in .env: DEMO_DOMAIN=demo.example.com
   docker compose up -d caddy   # recreates caddy with DEMO_DOMAIN in its environment
   docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
   docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```
   Both demo hosts answer 502 until step 5 is done. Deploys never touch this copy: when
   `infra/demo/caddy/demo.caddy` changes, copy it again and run the last two commands.
4. Prepare the demo clone and its environment before enabling automated demo deploys. Clone the
   repository production runs from. It needs read access only for this first clone: the Deploy
   workflow pushes every release into the demo's checkout, as it does into production's.
   ```sh
   git clone https://github.com/<owner>/<repo>.git /opt/starterdough-demo
   cd /opt/starterdough-demo
   cp infra/demo/.env.example .env && chmod 600 .env
   $EDITOR .env               # fill in DOMAIN, EMAIL_FROM and the secrets (openssl rand -hex 32 each)
   ```
   `DOMAIN` and `EMAIL_FROM` ship empty, and compose and the API refuse to start until they are
   set. The banner's "Buy" link goes to this demo's own marketing site (`infra/demo/compose.yml`
   names the page) unless `PUBLIC_DEMO_CTA_URL` names another.
5. In the repository's Actions variables, set `DEMO_PATH=/opt/starterdough-demo` and
   `DEMO_DOMAIN=demo.example.com`. The workflow derives the standard URLs from that domain.
   Custom layouts can override any of them with `DEMO_SITE_URL`, `DEMO_DOCS_URL`, `DEMO_WEB_URL`
   and `DEMO_API_URL`; those values must match the demo clone's `SITE_URL`, `DOCS_URL`, `WEB_URL`
   and `API_URL` rows. `DEMO_DOMAIN` remains required because it also identifies an enabled,
   fully configured demo build. Run the **Deploy** workflow with an empty `tag` (it needs
   `DEPLOY_ENABLED=true`, and a run by hand deploys only a commit whose CI passed on a push to
   `main`): it publishes `demo-static`, deploys production, then runs `infra/demo/update.sh` to pull
   and start the demo. An existing tag from before demo images were published is rejected before
   deployment.
6. Verify the stack. Initial bring-up pulled every image and did no compilation on the box.
   ```sh
   cd /opt/starterdough-demo
   docker compose ps
   curl -sS https://app.demo.example.com/readyz
   curl -sS -o /dev/null -w '%{http_code}\n' https://demo.example.com/
   curl -sS -o /dev/null -w '%{http_code}\n' https://demo.example.com/docs/
   ```
7. The nightly reset, as root:
   ```sh
   cp /opt/starterdough-demo/infra/demo/demo-reset.service /opt/starterdough-demo/infra/demo/demo-reset.timer /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now demo-reset.timer
   systemctl list-timers demo-reset.timer
   ```

The site blocks are `infra/demo/caddy/demo.caddy`, copied into the production clone's
`caddy/conf.d/` in step 3. Two hosts: the two static sites on the demo's own name, the app and its
API together on `app.` in front of it, which is `single-origin.Caddyfile`'s routing pointed at the
demo's upstreams. Both names come from `{$DEMO_DOMAIN}`, so the file is the same on every
deployment and never has a domain edited into it, and CI validates it the way Caddy loads it:
imported into a real `subdomains.Caddyfile`, and again with `DEMO_DOMAIN` unset, to prove that it
fails closed rather than loading half-configured.

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

**Update.** Every release updates the demo, then production, to the same build under one host
operation lock. `.github/workflows/deploy.yml` runs `bash infra/demo/update.sh` in the demo clone
first when the repository variable `DEMO_PATH` names that clone; unset it and nothing over there
is touched. The same script is the by-hand update, run from the demo clone.

It checks out that commit (the compose file and the migrations have to match the images), pulls
all images and restarts with `--no-build`, and it refuses to run anywhere but the demo before
it moves anything, the way `reset.sh` does. It is not a reset: the database, the volume and
whoever has signed up all survive, and visitors lose only their session when `demo-api` and
`demo-web` restart. A missing `demo-static` image fails before any writer is stopped or
container is replaced.

The pull needs a GHCR login, and by hand that is a login of the box's own: the one `deploy.yml`
makes is the workflow's token, which is revoked when the job ends. Rather than fail there, a run
whose `IMAGE_TAG` is a `sha-<commit>` falls back to the images already on the box when every one
of them is present, for example after an earlier successful pull. Set a PAT with `read:packages`
as the `GHCR_PULL_TOKEN` secret and the question goes away: every deploy then leaves a login
behind that does not expire.

For a self-host or an old tag whose pipeline never published `demo-static`, build only that image
explicitly from the matching checkout:

```sh
IMAGE_TAG=sha-abc1234 BUILD_DEMO_STATIC=1 bash infra/demo/update.sh
```

That mode pulls the other services, builds `demo-static` locally with the URLs in `.env`, and only
then stops writers and replaces containers. It is never selected automatically. The GitHub deploy
workflow rejects an existing tag without `demo-static` before it connects to the server; use this
command directly on a self-hosted demo, or publish the missing image before a workflow rollback.

**Take it down.** In the demo clone `docker compose down` (keeps the volume) or
`docker compose down -v` (wipes it); as root `systemctl disable --now demo-reset.timer`; unset the
`DEMO_PATH` repository variable, so deploys stop looking for a clone that is no longer there; in
the production clone delete `infra/caddy/conf.d/demo.caddy`, drop the `DEMO_DOMAIN` row from
`.env` and `caddy reload` as above. The overlay row and the network can stay or go: remove the row
from `COMPOSE_FILE`, `docker compose up -d`, `docker network rm starterdough-proxy`.

**Its own box later.** On a box of its own the demo is the ordinary self-hosted stack:
`provision.sh` with `EXPOSE=public`, the demo `.env` values on top of the generated `.env`
(`PUBLIC_DEMO_MODE=true`, `REQUIRE_EMAIL_VERIFICATION=false`, an empty `RESEND_API_KEY`, no keys,
and `PUBLIC_DEMO_CTA_URL` if the banner should link somewhere: `compose.yml` gives it no default)
with `DOMAIN=demo.example.com`, and the DNS records pointed at that box. Nothing from this
section is needed there: no drop-in, no shared network, no `infra/demo/compose.yml`. Two things
are not just a `DOMAIN` change. `compose.yml` has no single-origin mode with its own TLS
(`single-origin` expects Tailscale or a router in front), so the demo takes the subdomain layout
there, `app.demo.example.com` and `api.demo.example.com`, and the web image must be
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
| No traces | `OTEL_EXPORTER_OTLP_ENDPOINT` unset in `.env`, or the collector needs `OTEL_EXPORTER_OTLP_HEADERS` |
| `docker compose pull` denied | private GHCR packages: `docker login ghcr.io` with a token that has `read:packages`, or make the packages public |
| A Deploy run did nothing but its `Plan` job | its notice says why: `DEPLOY_ENABLED` is not `true` (lowercase), CI did not pass for that push, or `main` had already moved past the commit. The newer commit's own CI run releases it; a push CI skipped (`[skip ci]`) gets none, so push again |
| `Deliver the release commit to the server` fails | no git checkout at `DEPLOY_PATH` (or `DEMO_PATH`) that the deploy user owns: rerun `provision.sh`, or `chown -R deploy:deploy` the checkout |
| `Host key verification failed` in any workflow | the server's host key is not the one in `DEPLOY_KNOWN_HOSTS`: a rebuilt box, or the wrong host. Check the fingerprint in your provider's console before you replace the variable ("Deploy, update, roll back", step 2) |
| `Refuse a checkout that is not this product's` fails | `DEPLOY_PATH` or `DEMO_PATH` names another checkout, or the server's `.env` sets a `COMPOSE_PROJECT_NAME` the repository variable of the same name does not repeat |
| `Server clock against the runner's` fails | time synchronisation on the server: `timedatectl status`, then systemd-timesyncd or chrony |
| The release backup fails `… after waiting` | a nightly backup ran for more than its 10-minute wait; production is unchanged, so run Deploy again |

## Cloudflare notes

- Astro sites: static assets on Workers (`wrangler.jsonc` in `apps/site`, `apps/docs`).
- SvelteKit: `ADAPTER=cloudflare` selects `@sveltejs/adapter-cloudflare` (Workers static assets +
  SSR).
- The API stays on a container host: it uses Bun-native `Bun.SQL`, long-lived Postgres connections
  and Better Auth's full feature set, which do not fit Workers well. To run the API at the edge, use
  Hyperdrive for Postgres pooling and swap `drizzle-orm/bun-sql` for `drizzle-orm/postgres-js`.

