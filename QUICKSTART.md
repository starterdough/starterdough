# Starterdough Quickstart

> This guide gets the app running locally. It then splits the remaining work into two
> tracks: **what you do** (accounts, keys, decisions) and **what your coding agent does** (finish
> the rename, rebrand, build features).

- New here? Start at [Step 0](#step-0--prerequisites-5-minutes) and go in order.
- Experienced? The [command cheat sheet](#command-cheat-sheet) and [troubleshooting](#troubleshooting)
  are at the bottom.

## What you already have

Sign-up and sign-in (email, GitHub, Google, 2FA, passkeys), an admin dashboard (users, feature
flags, system), a marketing site, a docs site, English and German, dark mode, PWA/offline, and
one contract-first API (`/rpc`, `/api/v1`, OpenAPI). The API serves the web app, the Tauri
desktop and mobile shells, and anything else you build.

## How this guide works

| Track | Who | What |
| --- | --- | --- |
| 🟢 Boot | You (10 min) | Install, run, click through, create your admin |
| 🔵 Accounts and decisions | You (over a day or two) | Create service accounts, paste keys, answer product questions |
| 🟣 Build | Your agent (in parallel) | Finish the rename, rebrand, rewrite copy, add your features |

Give your agent [the handoff prompt](#what-to-tell-your-agent-copy-paste) as soon as the app boots.
Then work through the 🔵 checklist while it builds.

---

## Step 0 · Prerequisites (5 minutes)

| Need | Why | Install |
| --- | --- | --- |
| **Bun ≥ 1.4** | Runtime, package manager, test runner | [bun.sh](https://bun.sh): `powershell -c "irm bun.sh/install.ps1\|iex"` (Windows) or `curl -fsSL https://bun.sh/install \| bash` |
| **Docker with Compose and a running daemon**, or an existing **Postgres 17** | Local Postgres. Without Docker, see Step 1, item 4 | [docker.com](https://www.docker.com/products/docker-desktop/) |
| **Git** | Version control | [git-scm.com](https://git-scm.com) |
| **Rust** (desktop apps only) | Tauri shell | [rustup.rs](https://rustup.rs) |

Check:

```sh
bun --version     # want v1.4.x
docker --version
docker compose version
docker info --format "{{.ServerVersion}}"
git --version
node --version    # only if Node is installed: want v22.17 or newer
```

The Docker executable alone is not enough: Compose must be installed and the Docker service must
be running. After `bun run setup` below, `bun run doctor` checks these prerequisites and reports
the next action for each failure.

Node.js is not required. If it is installed, it must be 22.17 or newer (SvelteKit 3): `bun run dev`
and `bun run build` start Vite with the `node` on your PATH. Without Node, Bun runs Vite itself.

> Windows: use PowerShell. The local setup commands use the same syntax. Platform-specific
> deployment commands are labelled. If a port is taken, see [troubleshooting](#troubleshooting).

## Step 1 · Boot it (10 minutes)

**1. Get the code and install.** Start from a release, not from the kit's `main`, and keep the
kit's history: clone with the first block of [UPGRADING.md](UPGRADING.md#once-when-you-start). It
checks out the release you name, so name the newest (`git tag -l "kit/*" --sort=-v:refname` lists
them, newest first), and files the kit's tags under `kit/`, which every later upgrade merges from.
Then, from the repo root:

```sh
bun install
```

**2. Rename the kit.** Do this before `setup` and the first `db:up`: the slug becomes the Compose
project name and the Postgres role, `setup` copies it into your `.env`, and renaming later orphans
the database volume. See what it would change first; this is a dry run:

```sh
bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme
```

Then apply it on a branch the kit can follow: run the block under
[Rename on a branch the kit can follow](UPGRADING.md#rename-on-a-branch-the-kit-can-follow) in
UPGRADING.md with the same arguments. It renames the release on a `kit-renamed` branch, commits it
and merges it into `main`, so each later release is renamed the same way and merges without a
conflict on every renamed line. Already renamed `main` in place? Run that page's "Already renamed
`main` another way?" block once, with the arguments you used, before your first upgrade.

`rename` rewrites four tokens across the tracked text files: the product name, the slug (npm
package name, Cargo crate, Compose project, Postgres role, container names, backup prefix), the
Tauri bundle identifier and the workspace scope. It then prints a residue checklist of things it
does not touch: Docker volumes, an existing dev database, the untracked `.env`, the lockfiles and
the kit's GitHub URLs. It leaves `LICENSE.md`, `THIRD-PARTY.md`, `CHANGELOG.md` and `UPGRADING.md`
as they are.
No name yet? Skip this step. Renaming after `db:up` still works, but you then follow the volume and
`.env` steps that checklist prints.

**3. Create your environment files.**

```sh
bun run setup
```

`setup` creates every `.env` from the `.env.example` next to it: the root one (API, database
tooling, Compose), `apps/web`, `apps/site` and `apps/docs`. It generates `BETTER_AUTH_SECRET` and
gives the marketing site and the docs their local `SITE_URL`, so a full `bun run build` works too.
Nothing else needs editing for local development, and each file documents its own variables. Run
it again whenever you like: it fills only rows that are absent or blank, never replaces a value
you set, and prints no secret.

These secrets are for your machine. A deployment generates its own: `provision.sh` does it on a
VPS (Step 4); elsewhere use `openssl rand -hex 32`, or
`bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` where there is no OpenSSL.

**4. Check setup, start Postgres and run the migrations.** `db:migrate` exits 1 if a migration is
still pending after the run.

```sh
bun run doctor
bun run db:up
bun run db:migrate
```

`doctor` is read-only: it checks local prerequisites and configuration without printing values
from your environment files. It checks development/test settings; the API remains responsible for
full validation, including production settings, when it starts. It does not connect to the database,
check migrations or prove that signup works. Complete the checkpoint below after migrations.

Already have PostgreSQL? Point `DATABASE_URL` at a dedicated development database and run
`bun run doctor -- --database=external`. Then omit `db:up` and run `db:migrate` against that
database. This option deliberately skips Docker checks; it does not install or configure Postgres.
Use Postgres 17 for the free edition; it does not require the vector extension.

**5. Start the API and the web app.**

```sh
bun run dev:app
```

Open **http://localhost:5173**. Then:

1. **Sign up** at `/signup`. In development the verification link prints in the API terminal.
2. **Promote your account to platform administrator** in a new terminal at the repo root. The
   `--yes` flag confirms promotion of the account you just created and leaves its password
   unchanged:
   ```sh
   bun run admin:create -- --email you@example.com --name 'You' --yes
   ```
   Sign in as that user and open **http://localhost:5173/admin** for users, feature flags and
   system status.
3. **See the rest** (optional):
   ```sh
   bun run dev:site    # marketing site at http://localhost:4321
   bun run dev:docs    # docs at http://localhost:4322
   ```


| Service | URL | Notes |
| --- | --- | --- |
| App | http://localhost:5173 | Sign up, `/app`, `/admin` |
| API | http://localhost:3000 | Health: `/api/v1/health` · OpenAPI: `/api/v1/openapi.json` |
| Site | http://localhost:4321 | Marketing, pricing, blog, contact |
| Docs | http://localhost:4322 | Your product docs, with a live API reference |
| Postgres | `localhost:5433` | Docker, `pgvector/pgvector:pg17` (`starterdough`/`starterdough`). A host Postgres on 5432 is left alone |

✅ **Checkpoint:** you can sign up, sign in and open `/admin` as your admin user.
Now hand off to your agent (next section) and keep going below in parallel. The
[worked feature example](apps/docs/src/content/docs/guides/feature-example.md) shows the expected
database, contract, permission, translation, form and test path using the shipped feature flags.

---

## What to tell your agent (copy-paste)

Paste this into your coding agent and fill in the brackets. It lists the repo's hard rules so the
agent does not have to discover them.

```text
Read AGENTS.md first.
This repo is Starterdough, a Bun SvelteKit + Hono/oRPC SaaS starter. Then read README.md,
QUICKSTART.md, docs/DECISIONS.md, and apps/web/README.md.

My product: [1 to 2 sentences, e.g. "invoicing for freelance designers"].
Product name: [Name]. Domain: [example.com or "none yet"].

Please do the following, in order, running `bun run verify` (lint, typecheck and tests)
after each step:
1. Finish the rename. If a kit-renamed branch exists, or `productName` in
   apps/native/src-tauri/tauri.conf.json is already the product name above, QUICKSTART.md Step 1
   renamed the kit: do not run `bun run rename` again. If not, rename on the kit-renamed branch
   exactly as UPGRADING.md "Rename on a branch the kit can follow" shows, with the product name
   above (agree the slug, identifier and scope with me first). Then finish the residue checklist
   at the end of scripts/rename.ts, the one `rename` prints: titles, emails, legal placeholders.
2. Rebrand: theme tokens (packages/ui/src/theme.css), logo/favicon, OG defaults.
3. Rewrite apps/site copy (landing, features, blog starter posts, legal) for my product.
4. Add/modify features: [your feature list].

Hard rules (do not break):
- Contract first: new endpoint = entry in packages/api-contract → implement in apps/api →
  call via @repo/api-client. Never import @repo/db, @repo/auth/server, @repo/env or any other
  server-only package from apps/web or apps/site.
- No literal UI text in apps/web: every string is a Paraglide message in
  apps/web/messages/{en,de}/<area>.json. No Tauri IPC: the API is the backend everywhere.
- Validate forms with the contract's schema (via zodForm), never a copy.
- Biome only (tabs, single quotes). Regenerate generated code, don't hand-edit it.

Tell me when each step is done and what decisions you need from me.
```

---

## Step 2 · Your parallel checklist (while the agent builds)

Do these in any order. Each one ends with "paste X into Y".

### A. Accounts and keys

- [ ] **Email (Resend)**: [resend.com](https://resend.com)
  - Without it, every email prints to the API console. Fine for development.
  - Verify your domain, create an API key → `RESEND_API_KEY`. Set `EMAIL_FROM="Your Product
    <hello@yourdomain>"` and `CONTACT_EMAIL="you@yourdomain"` in the root `.env`. Restart the API.
  - **Production requires both.** With `NODE_ENV=production` the API refuses to start without
    `RESEND_API_KEY`, or with an `EMAIL_FROM` on `localhost`, `example.*`, a reserved or a dotless
    domain.
- [ ] **GitHub / Google sign-in** (optional)
  - Create an OAuth app on each provider with the callback URL
    `http://localhost:3000/api/auth/callback/github` (or `/google`). Use your API origin in
    production. Set `GITHUB_CLIENT_ID/SECRET` and/or `GOOGLE_CLIENT_ID/SECRET` in the root `.env`.
    The buttons appear automatically.
- [ ] **Sentry** (error tracking, optional): [sentry.io](https://sentry.io)
  - Create a SvelteKit project. Set `PUBLIC_SENTRY_DSN` (browser) and `SENTRY_DSN` (SSR) in
    `apps/web/.env`. Empty means the SDK is not loaded.
- [ ] **PostHog** (analytics, optional): [posthog.com](https://posthog.com)
  - Set `PUBLIC_POSTHOG_KEY` in `apps/web/.env` (plus `PUBLIC_POSTHOG_HOST` for EU). A consent
    banner appears; nothing is sent until visitors accept.
- [ ] **Domain + Cloudflare** (for launch): buy the domain, add it to Cloudflare.
  - Static sites: `bun run --cwd apps/site deploy:cloudflare` (same for `apps/docs`), with that
    app's `SITE_URL` set to its public origin. It refuses a localhost one.
  - App SSR at the edge: build `apps/web` with `ADAPTER=cloudflare`. The API stays on a container
    host; it needs long-lived Postgres connections.
- [ ] **Tailscale** (self-hosting, or demoing from your laptop): [tailscale.com](https://tailscale.com)
  - `tailscale serve --bg 80` (private, your devices) or `tailscale funnel --bg 80` (public URL,
    no open ports). See [Step 4](#step-4--deploy-pick-one).
- [ ] **Desktop / mobile installers** (optional, needs Rust)
  - `bun run build:desktop` requires `PUBLIC_API_URL` **and** `PUBLIC_WEB_URL`. `PUBLIC_WEB_URL` is
    where the shell's emailed links point; its own origin (`tauri://localhost` or
    `http://tauri.localhost`) is not an address a browser can open. The shells sign in with email
    and password only (see `apps/native/README.md`). Both are repository variables for the
    `Desktop` workflow.
  - To release: bump `version` in the root `package.json`. The generator writes `Cargo.toml`,
    `apps/native/package.json` and the Tauri config from it. Push a `v<version>` tag. The workflow
    builds every platform and collects the artifacts into one **draft** release. A tag that does
    not match the root version fails the run before anything is built.

### B. Decisions only you can make

Write these down and hand them to your agent:

- [ ] **Name, tagline, domain.** Everything user-visible is renamed from this.
- [ ] **Branding.** Logo, favicon, colors (light and dark), OG image style.
- [ ] **Copy.** Landing hero, 6 to 8 feature blurbs, pricing bullets, 2 launch blog posts,
  changelog voice.
- [ ] **Legal.** Privacy policy and terms ship as templates with `[placeholders]` in the site. Have
  them reviewed; they are not legal advice. The privacy template's sub-processor table lists every
  third party the kit can send data to. Delete the rows that do not apply and name the providers
  you use.
- [ ] **Languages.** English and German ship. Each extra language is a `messages/<locale>/*.json`
  translation plus one config line; ask the agent.
- [ ] **Support.** The `CONTACT_EMAIL` destination, and where users reach you (email, Discord).

### C. Verify as the agent lands changes

After each agent delivery, run this loop:

```sh
bun run verify     # lint, typecheck and tests, in CI's order
bun run build      # every app, the way CI builds them
bun run test:e2e   # production preview + accessibility + locale checks
```

The component tests run in a real browser. The first `verify` on a fresh machine installs
Playwright's Chromium; later runs skip that.

Then click through: sign up → verify → `/account` → `/admin` (users, flags). If it all works,
merge it.

---

## Step 3 · Connect the sites (10 minutes)

The marketing site's contact form and the docs' live API reference call the API from the browser,
so their origins must be allowed:

- **Development:** `http://localhost:4321` and `:4322` are allowed automatically. Nothing to fill
  in for `bun run dev`.
- **Building either site:** each one bakes its own `SITE_URL` into canonical URLs, the sitemap
  and OG tags. `bun run setup` gave `apps/site/.env` and `apps/docs/.env` their local origins
  (`http://localhost:4321` and `:4322`), so a local `bun run build` works as it is. Before you
  deploy, replace each with that site's public origin: the build refuses an unset value or an
  `example.com` placeholder, and `deploy:cloudflare` also refuses localhost. The other variables
  (`PUBLIC_APP_URL`, `PUBLIC_DOCS_URL`, `PUBLIC_API_URL`, and the optional `PUBLIC_REPO_URL`,
  `PUBLIC_CONTACT_EMAIL`, `DOCS_REPO_URL`) are in the same two files.

Keep the public app/API targets in those files aligned with your running app. Run
`bun run doctor -- --build` before `bun run build` (add `--database=external` if applicable).
A nonempty `SITE_URL` exported by your shell overrides both per-app files. Leave that export unset
when the sites have different origins. The root `.env` rows `SITE_URL` and `DOCS_URL` configure
container builds; the docs app reads its own `SITE_URL` when built locally. Blank inherited
`SITE_URL` values allow each app's file to supply its origin.

- **Production:** add your real origins to the root `.env`:
  ```sh
  TRUSTED_ORIGINS=https://example.com,https://docs.example.com
  ```
  Add `tauri://localhost,http://tauri.localhost` if you ship desktop or mobile.
- Contact form mail goes to `CONTACT_EMAIL`. With Resend set and no `CONTACT_EMAIL`, the form
  answers `412`. Set the address.

## Step 4 · Deploy (pick one)

### Option A: Cloud

- API + Postgres on one container host (Fly.io, Railway, Hetzner + Coolify). Dockerfiles ship in
  each app. Managed Postgres plus the API container also works.
- Sites, and optionally the app SSR, on Cloudflare: `bun run --cwd apps/site deploy:cloudflare`,
  the same for `apps/docs` (each needs its own `SITE_URL`), and `apps/web` with
  `ADAPTER=cloudflare`.

### Option B: Self-host everything on one VPS

```sh
# one-time (Ubuntu/Debian): Docker, Tailscale, a `deploy` user, ufw, the clone, .env with secrets
curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/infra/scripts/provision.sh \
  | sudo REPO_URL=https://github.com/<you>/<repo>.git EXPOSE=tailscale bash   # or EXPOSE=public
# from a private repository: copy provision.sh to the box and pass GIT_TOKEN (the top of the script
# shows how)

# then, from the clone, as the deploy user. COMPOSE_FILE is in .env, so no -f.
# provision.sh generated the secrets .env needs and set CADDY_MODE; you still fill DOMAIN (public)
# or WEB_URL + API_URL (tailnet)
docker compose up -d --build

# the first platform administrator, from the checkout (provision.sh installed Bun for `deploy`
# and wrote a DATABASE_URL for the compose Postgres on 127.0.0.1:5433 into .env)
bun install
ADMIN_PASSWORD='Something-Strong-123' bun run admin:create -- --email you@example.com --name 'You'
```

- `CADDY_MODE=subdomains` (public): `DOMAIN`, `docs.`, `app.`, `api.` with automatic HTTPS. Set
  `COOKIE_DOMAIN=.yourdomain` so the session spans `app.` and `api.`.
- `CADDY_MODE=single-origin` (tailnet/LAN or Tailscale Funnel; what `EXPOSE=tailscale`
  provisions): one host with path routing. Set `WEB_URL` and `API_URL` to that same origin. Docs
  are at `/docs`.
- Backups from day one. `COMPOSE_PROFILES=backup` is already in the provisioned `.env`. Take one
  now:
  ```sh
  docker compose run --rm backup bun src/cli.ts backup
  docker compose run --rm backup bun src/cli.ts list                    # exits 1 on a stale set
  docker compose run --rm backup bun src/cli.ts restore latest --drill  # checksum + row counts
  ```
  Set `BACKUP_S3_BUCKET` so copies leave the box, and `BACKUP_HEARTBEAT_URL` so a missed night
  alerts you. `list` exits 1 when the newest set is older than `BACKUP_MAX_AGE` (36 h); use it in a
  cron or health check, or pass `--no-max-age` to skip the check. A real restore re-hashes the dump
  against the manifest's `sha256`, refuses a database-name mismatch (`--force-database-mismatch`
  overrides) and refuses to run while the API is connected (`docker compose stop api`, or
  `--terminate-connections`). It runs `--single-transaction --exit-on-error` under
  `BACKUP_LOCK_TIMEOUT`. The dump is **plaintext**, so harden the bucket: versioning or object
  lock, a write-only credential, a lifecycle rule, server-side encryption. Runbook:
  `infra/README.md`.
- CI deploys are off until you set the repository variable `DEPLOY_ENABLED=true`, so pushing your
  copy to GitHub runs CI and nothing else. Once on, the Deploy workflow runs after CI passes on
  `main`: it builds the images from that commit, pushes them to GHCR, pushes the commit to the
  server and runs `infra/scripts/deploy.sh` there. It needs the four repository variables the
  `caddy` image bakes in (`SITE_URL`, `DOCS_URL`, `WEB_URL`, `API_URL`; the build names any that is
  missing), `DEPLOY_HOST`, and the secret `DEPLOY_SSH_KEY`. There is no deploy key: the server
  never fetches from GitHub. The setup, in order, is in `infra/README.md`, "Deploy, update, roll
  back".
- To pull those images instead of building on the box
  (`docker login ghcr.io && docker compose pull && docker compose up -d`), point `IMAGE_REGISTRY`
  at **your** fork's namespace (`provision.sh` derives it from `REPO_URL`; `deploy.sh` pins what CI
  passed). While the packages are private you also need a token with `read:packages`.

## Step 5 · Launch checklist

- [ ] Production `.env`: a real `BETTER_AUTH_SECRET`, a `COOKIE_DOMAIN` that is a bare hostname
  covering both `WEB_URL` and `API_URL`, `TRUSTED_ORIGINS`, `RESEND_API_KEY`, `EMAIL_FROM` (on a
  domain you verified) and `CONTACT_EMAIL`. The API refuses to start in production without the
  email provider or a real sender domain, and names the variable. The first `docker compose up`
  is the check.
- [ ] OAuth callbacks registered for the production API origin.
- [ ] Legal pages reviewed, contact email monitored.
- [ ] Backups scheduled, one restore drill (`restore latest --drill`), `list` wired into a cron or a
  health check, and the backup bucket hardened (versioning, a write-only credential, a lifecycle
  rule, server-side encryption).
- [ ] Sentry and uptime monitoring (for example Better Stack, or `COMPOSE_PROFILES=monitoring` in
  `.env`) watching `/readyz`.
- [ ] `BACKUP_S3_*` set, or an off-box copy of the `backups` volume.
- [ ] `REQUIRE_EMAIL_VERIFICATION` left at its default (on in production).

---

## Command cheat sheet

| Command | What it does |
| --- | --- |
| `bun run setup` | Create or complete every local `.env` from its template, with generated secrets. Never replaces a value you set |
| `bun run doctor` | Read-only local prerequisite and app configuration check; `-- --build` includes site/docs configuration, `-- --database=external` skips Docker for an existing database |
| `bun run dev:app` | API (:3000) + web app (:5173). The daily driver |
| `bun run dev` | Everything with a dev script (adds site :4321, docs :4322) |
| `bun run dev:site` / `dev:docs` | Only the marketing site / docs |
| `bun run dev:desktop` | Tauri desktop shell on the dev server, with HMR (needs Rust; keep `dev:app` or `dev:api` running) |
| `bun run preview:desktop` / `build:desktop` | The shell as it ships (debug window over the static build) / installers in `apps/native/src-tauri/target/release/bundle` |
| `bun run db:up` / `db:down` | Start / stop local Postgres |
| `bun run db:migrate` / `db:studio` | Apply migrations / browse the DB |
| `bun run admin:create -- --email … [--name …] [--yes]` | Create or promote a platform admin (password from `ADMIN_PASSWORD` or a prompt) |
| `bun run licenses` | Dependency-licence audit. `--strict` is CI's gate; `THIRD-PARTY.md` is the write-up |
| `bun run rename` | Rename the kit to your product (dry run without `--write`) |
| `bun run verify` | Lint, typecheck and tests in CI's order |
| `bun run check` / `test` / `lint` / `build` | The same steps one at a time (`test` installs Playwright's Chromium on first run) |
| `bun run test:e2e` | Playwright: production preview, axe accessibility, locale checks |
| `bun run auth:schema` | After changing auth plugins. Fails until you put back the hand-added constraints it names ([how](apps/docs/src/content/docs/guides/authentication.md#changing-auth-plugins)); then `db:generate`, check the migration drops none of them, `db:migrate` |
| `bun run api:openapi` | Regenerate `apps/api/openapi.json` |
| `bunx shadcn-svelte@latest add <name> -c packages/ui` | Add a UI component (then export it) |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Port taken (`3000`/`5173`) after closing a terminal | The old `bun`/`vite` process is still running. Kill it (Windows: end `bun.exe` / `node.exe` in Task Manager), then `bun run dev:app` again |
| Docker exists but `db:up` fails before starting Postgres | Run `bun run doctor`. Install the Compose plugin if missing; start Docker Desktop or the Docker daemon if unreachable. Do not treat `docker --version` as readiness |
| `db:up` fails / port `5433` busy | Set `POSTGRES_PORT=5434` in the root `.env` (and in `DATABASE_URL`), then `bun run db:up` again |
| `/api/auth/*` returns 500 after editing auth | `bun run auth:schema`, put back the hand-added constraints it names, then `bun run db:generate` (the migration must not drop them) and `bun run db:migrate`; restart `dev:app` |
| Changed a `packages/*` file, API did not pick it up | Restart `dev:app`. `--hot` watches `apps/api` only, and `--env-file` is read at start |
| `dev:app` stops after a save, with an error like `SyntaxError: Export named 'x' not found` | A save that briefly broke an import made the API exit on purpose: an unhandled rejection is fatal (`apps/api/src/lifecycle.ts`), and turbo then stops the web server too. Finish the edit and run `bun run dev:app` again |
| Contact form / Scalar show CORS errors | The site or docs origin must be in `TRUSTED_ORIGINS` (dev `:4321`/`:4322` are automatic; production is not) |
| Emails do not arrive | Empty `RESEND_API_KEY` = console only (check the API terminal). With Resend set, verify the domain and `EMAIL_FROM` |
| Social button missing | Both `*_CLIENT_ID` and `*_SECRET` must be set, and the callback URL registered with the provider |
| Astro build needs network | The `apps/site` build fetches the OG-image font. Expected |
| `astro build` fails with "SITE_URL is not set" (or "still the placeholder") | Run `bun run setup`: it gives an empty `SITE_URL` the local origin. `bun run doctor -- --build` checks both sites. A nonempty shell export wins over those files. Deployment needs real public origins |
| `db:migrate` exits 1 with "still pending after the run" | A merge interleaved migration timestamps and Drizzle skipped a file older than the newest applied one. Regenerate those so they sort last, or apply them by hand |
| Sign-in succeeds but the session never sticks | `COOKIE_DOMAIN` must be a bare hostname (`.example.com`, not a URL) covering both `WEB_URL` and `API_URL`. The API refuses to start on any other value |
| The API refuses to start in production | It names the variable: no `RESEND_API_KEY`, an `EMAIL_FROM` on localhost / example / a dotless domain, or a `COOKIE_DOMAIN` that does not cover both origins |

## Where to go next

- `README.md`: what Starterdough is and how it is built
- `apps/web/README.md`, `apps/site/README.md`, `apps/docs/README.md`: per-app details
- `docs/DECISIONS.md`: the architecture decision records
- `infra/README.md`: hosting, Caddy modes, Tailscale, backups, Cloudflare notes
- `LICENSE.md`: what you may do with the kit. `THIRD-PARTY.md`: what it depends on and the two
  notices that ship with your product. `CHANGELOG.md` and `UPGRADING.md`: what changed per release
  and how to merge a release into your renamed fork. `SECURITY.md`: how to report a vulnerability
- Live API surface: http://localhost:3000/api/v1/openapi.json (or Docs → API reference)
