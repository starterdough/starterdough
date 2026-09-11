# Starterdough Quickstart — from clone to your product

> A working SaaS, not a pile of parts. This guide gets it running in ~10 minutes,
> then splits the remaining work into two parallel tracks: **what you do** (accounts, keys,
> decisions only you can make) while **your agent** reshapes the product to your requirements.

- New here? Start at [Step 0](#step-0-prerequisites-5-minutes) and go in order.
- Technical? The [command cheat sheet](#command-cheat-sheet) + [troubleshooting](#troubleshooting) are at the bottom.
- This file ships with the repo (it is **not** gitignored). `HANDOFF.md` / `ROADMAP.md` are
  maintainer working notes and are *not* included — everything you need is here.

## What you already have

Out of the box: sign-up / sign-in (email, GitHub, Google, 2FA, passkeys), an admin dashboard
(users, feature flags, system), a marketing site + docs site, English + German, dark mode,
PWA/offline, and one contract-first API (`/rpc` + `/api/v1` + OpenAPI) that serves the web app,
the Tauri desktop/mobile shells, and anything else you build.

## How this guide works

| Track | Who | What |
| --- | --- | --- |
| 🟢 Boot | You (10 min) | Install, run, click through, create your admin |
| 🔵 Accounts & decisions | You (over a day or two) | Create service accounts, paste keys, answer product questions |
| 🟣 Build | Your agent (in parallel) | Rename, rebrand, rewrite copy, adjust plans/limits, add your features |

Give your agent [this handoff prompt](#what-to-tell-your-agent-copy-paste) as soon as the app
boots — then work through the 🔵 checklist while it works.

---

## Step 0 · Prerequisites (5 minutes)

| Need | Why | Install |
| --- | --- | --- |
| **Bun ≥ 1.4** | Runtime, package manager, test runner (one tool) | [bun.sh](https://bun.sh) — `powershell -c "irm bun.sh/install.ps1\|iex"` (Win) or `curl -fsSL https://bun.sh/install \| bash` |
| **Docker** | Local Postgres | [docker.com](https://www.docker.com/products/docker-desktop/) |
| **Git** | Version control | [git-scm.com](https://git-scm.com) |
| **Rust** (only for desktop apps) | Tauri shell | [rustup.rs](https://rustup.rs) |

Check:

```sh
bun --version     # want v1.4.x
docker --version
git --version
```

> Windows: use PowerShell. `cp` below also works as `Copy-Item`. If a port is taken, see
> [troubleshooting](#troubleshooting).

## Step 1 · Boot it (10 minutes)

Every command in this guide is the same in bash and in PowerShell — copy them as they are.

```sh
# 1. Install everything (root of the repo)
bun install

# 2. Make it yours. Not optional, and far easier now than later: the slug becomes the Compose
#    project name, so renaming after the first `db:up` orphans the database volume. Dry run, then
#    --write, then install again for the new package names.
bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme
bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme --write
bun install

# 3. Copy the env templates (each app documents its own variables)
cp .env.example .env
cp apps/web/.env.example apps/web/.env
cp apps/site/.env.example apps/site/.env
cp apps/docs/.env.example apps/docs/.env
```

`rename` rewrites four tokens across the tracked text files — the product name, the lowercase slug
(npm package name, Cargo crate, Compose project, Postgres role, container names, the backup artefact
prefix), the Tauri bundle identifier and the workspace scope — and then prints a **residue
checklist** of everything a text substitution must not touch: Docker volumes, an existing dev
database, the untracked `.env`, the lockfiles, and the kit's own GitHub coordinates. `LICENSE.md`,
`THIRD-PARTY.md`, `CHANGELOG.md` and `UPGRADING.md` are left verbatim on purpose — they describe the
kit you licensed, not your product. No name yet? Skip it and come back before your first commit: the
script reads the current values out of the checkout, so it works whenever you run it.

**4. Generate your auth secret.** `BETTER_AUTH_SECRET` ships empty — it is the one value with no
default, and the API refuses to boot without it. Run this and paste the output into root `.env` as
`BETTER_AUTH_SECRET=…`:

```sh
bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> Why Bun and not `openssl`? Because Bun is already installed and PowerShell has no `openssl`. The
> same line generates `POSTGRES_PASSWORD` and `SERVICE_TOKEN` later (`randomBytes(16)` / `(24)`).

```sh
# 5. Start Postgres and run the migrations. db:migrate exits 1 if anything is still pending when it
#    finishes — a merge can interleave migration timestamps, which Drizzle would otherwise skip.
bun run db:up
bun run db:migrate

# 6. Start the API + the web app
bun run dev:app
```

Open **http://localhost:5173** — you should see the landing page. Then:

1. **Sign up** as yourself (`/signup`). In development, the verification link is printed in the
   API terminal — no email setup needed yet.
2. **Create your admin account** (new terminal, repo root). The password comes from
   `ADMIN_PASSWORD`, or from an interactive prompt when that is unset — never from the command
   line, where it would stay in shell history and be visible in `ps`:
   ```sh
   ADMIN_PASSWORD='Something-Strong-123' bun run admin:create -- --email you@example.com --name 'You'
   # add --yes at the end to promote an account that already exists
   ```
   Sign in as that user and open **http://localhost:5173/admin** — users, feature flags,
   system status.
3. **See the rest** (optional, same repo):
   ```sh
   bun run dev:site    # marketing site → http://localhost:4321
   bun run dev:docs    # docs → http://localhost:4322
   ```


| Service | URL | Notes |
| --- | --- | --- |
| App | http://localhost:5173 | Sign up, `/app`, `/admin` |
| API | http://localhost:3000 | Health: `/api/v1/health` · OpenAPI: `/api/v1/openapi.json` |
| Site | http://localhost:4321 | Marketing, pricing, blog, contact |
| Docs | http://localhost:4322 | Your product docs, incl. live API reference |
| Postgres | `localhost:5433` | Docker, `pgvector/pgvector:pg17` (`starterdough`/`starterdough`); host PG on 5432 is left alone |

✅ **Checkpoint:** you can sign up, sign in, create an org, and open `/admin` as your admin user.
If yes — hand off to your agent now (next section) and keep going below in parallel.

---

## What to tell your agent (copy-paste)

> Paste this into your coding agent, then fill in the brackets. It encodes the repo's hard rules
> so the agent doesn't have to discover them.

```text
This repo is Starterdough, a Bun SvelteKit + Hono/oRPC SaaS starter. Read README.md,
QUICKSTART.md, docs/DECISIONS.md, and apps/web/README.md first.

My product: [1–2 sentences — e.g. "invoicing for freelance designers"].
Product name: [Name]. Domain: [example.com or "none yet"].

Please do the following, in order, verifying with `bun run check`, `bun run test`,
`bun run lint`, and `bun run build` as you go:
1. Rename the product (name, titles, emails, legal placeholders, scope if you rename @repo/*).
2. Rebrand: theme tokens (packages/ui/src/theme.css), logo/favicon, OG defaults.
3. Rewrite apps/site copy (landing, features, blog starter posts, legal) for my product.
4. Add/modify features: [your feature list].

Hard rules (do not break):
- Contract first: new endpoint = entry in packages/api-contract → implement in apps/api →
  call via @repo/api-client. Never import @repo/db, @repo/auth/server, @repo/env or any other
  server-only package from apps/web or apps/site.
- No literal UI text in apps/web: every string is a Paraglide message in
  apps/web/messages/{en,de}/<area>.json. No Tauri IPC — the API is the backend everywhere.
- Validate forms with the contract's schema (via zodForm), never a copy.
- Biome only (tabs, single quotes). Regenerate generated code, don't hand-edit it.

Tell me when each step is done and what decisions you need from me.
```

---

## Step 2 · Your parallel checklist (while the agent builds)

Do these in any order. Each one ends with "paste X into Y" — that's the whole integration.

### A. Accounts & keys

- [ ] **Email (Resend)** (so emails actually send) — [resend.com](https://resend.com)
  - Without it, everything prints to the API console (fine for dev).
  - Verify your domain, create an API key → `RESEND_API_KEY`, set `EMAIL_FROM="Your Product
    <hello@yourdomain>"` and `CONTACT_EMAIL="you@yourdomain"` in root `.env`, restart the API.
  - **Production requires both.** The API refuses to boot with `NODE_ENV=production` and no
    `RESEND_API_KEY`, or with an `EMAIL_FROM` on `localhost`, `example.*`, a reserved or a dotless
    domain. The old behaviour was a silent fall back to the console provider: nobody could verify an
    address, and every reset token went into the log instead.
- [ ] **GitHub / Google sign-in** (optional)
  - Create an OAuth app on each provider with callback URL
    `http://localhost:3000/api/auth/callback/github` (and `/google`; swap in your API origin in
    production). Set `GITHUB_CLIENT_ID/SECRET` and/or `GOOGLE_CLIENT_ID/SECRET` in root `.env` —
    the buttons appear automatically.
- [ ] **Object storage (R2 / S3)** (for uploads in production; local disk works until then)
  - Create a bucket, add a CORS rule allowing your app origin (`PUT`, `GET`, header `Content-Type`),
    create an access key → `S3_BUCKET`, `S3_ENDPOINT` (R2: `https://<account-id>.r2.cloudflarestorage.com`),
    `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` in root `.env`, restart the API.
  - Also set `PUBLIC_STORAGE_ORIGIN` to the bucket's origin (scheme and host only). Every `S3_*`
    value is server-only, so neither the browser nor the desktop shell can derive it, and their
    Content-Security-Policy blocks the presigned `PUT` until that origin is listed.
- [ ] **Sentry** (error tracking, optional) — [sentry.io](https://sentry.io)
  - Create a SvelteKit project → `PUBLIC_SENTRY_DSN` (browser) and `SENTRY_DSN` (SSR) in
    `apps/web/.env`. Empty = the SDK isn't even loaded.
- [ ] **PostHog** (analytics, optional) — [posthog.com](https://posthog.com)
  - `PUBLIC_POSTHOG_KEY` in `apps/web/.env` (+ `PUBLIC_POSTHOG_HOST` for EU). A consent banner
    appears; nothing is sent until visitors accept.
- [ ] **Domain + Cloudflare** (for launch) — buy the domain, add it to Cloudflare.
  - Static sites: `bun run --cwd apps/site deploy:cloudflare` (same for `apps/docs`), with that
    app's `SITE_URL` set.
  - App SSR at the edge: `ADAPTER=cloudflare` build of `apps/web`. The API stays on a container
    host (it needs long-lived Postgres connections).
- [ ] **Tailscale** (if self-hosting or demoing from your laptop) — [tailscale.com](https://tailscale.com)
  - `tailscale serve --bg 80` (private, your devices) or `tailscale funnel --bg 80` (public URL,
    no open ports). See [Step 4](#step-4-deploy-pick-one).
- [ ] **Desktop / mobile installers** (optional) — needs Rust.
  - `bun run build:desktop` refuses to start unless `PUBLIC_API_URL` **and** `PUBLIC_WEB_URL` hold
    real values. `PUBLIC_WEB_URL` is where OAuth and other external return trips land: the webview's own
    `tauri.localhost` is not an address any provider can redirect to, and with it unset those
    buttons are hidden rather than dead-ending the user in the system browser. Add
    `PUBLIC_STORAGE_ORIGIN` when uploads go to a bucket. All three are repository variables for the
    `Desktop` workflow.
  - To release: bump `version` in the root `package.json` — the single source of truth, from which
    the generator writes `Cargo.toml`, `apps/native/package.json` and the Tauri config, so
    `Cargo.lock` moves with it — then push a `v<version>` tag. The workflow builds every platform
    and a final job collects the artifacts into one **draft** release; a tag that does not match the
    root version fails the run before anything is built.

### B. Decisions only you can make

Write these down and hand them to your agent — they're the difference between a template and
*your* product:

- [ ] **Name, tagline, domain.** Everything user-visible is renamed from this.
- [ ] **Branding.** Logo, favicon, colors (light + dark), OG image style.
- [ ] **Copy.** Landing hero, 6–8 feature blurbs, pricing bullets, 2 launch blog posts, changelog voice.
- [ ] **Legal.** Privacy policy + terms (templates with `[placeholders]` ship in the site — have
  them reviewed; they're not legal advice). The privacy template's sub-processor table lists every
  third party the kit can send data to, including the object store and the AI provider, which
  receive your users' document contents — delete the rows that do not apply to how you configured
  it, and name the providers you actually use.
- [ ] **Languages.** English + German ship; list any others (each is a `messages/<locale>/*.json`
    translation + one config line — ask the agent).
- [ ] **Support.** `CONTACT_EMAIL` destination, and where users reach you (email, Discord, …).

### C. Verify as the agent lands changes

After each agent delivery, run this 5-minute loop:

```sh
bun run verify     # lint, typecheck and tests, in CI's order
bun run build      # every app, the way CI builds them
bun run test:e2e   # production preview + accessibility + locale checks
```

The component tests run in a real browser, so the first `verify` on a fresh machine installs
Playwright's Chromium for you; later runs skip that.

Then click: sign up → verify → `/account` → `/admin` (users, flags). If it all works, merge it.

---

## Step 3 · Connect the sites (10 minutes)

The marketing site's contact form and the docs' live API reference call the API from the
browser, so their origins must be allowed:

- **Development:** `http://localhost:4321` and `:4322` are allowed automatically, and both sites
  fall back to those origins, so there is nothing to fill in for `bun run dev`.
- **Before you build either site:** set its own `SITE_URL` (the marketing origin for `apps/site`,
  the docs origin for `apps/docs`). `astro build` **fails** without one, and fails on an
  `example.com` placeholder — otherwise every canonical URL, `og:image`, RSS link and sitemap entry
  in the output would point at somebody else's domain and nothing would say so. The rest of each
  site's variables (`PUBLIC_APP_URL`, `PUBLIC_DOCS_URL`, `PUBLIC_API_URL`, and the optional
  `PUBLIC_REPO_URL`, `PUBLIC_CONTACT_EMAIL`, `DOCS_REPO_URL`) are in the two `.env.example` files.
- **Production:** add your real origins to root `.env`:
  ```sh
  TRUSTED_ORIGINS=https://example.com,https://docs.example.com
  ```
  (plus `tauri://localhost,http://tauri.localhost` if you ship desktop/mobile).
- Contact form mail goes to `CONTACT_EMAIL`. With Resend set and no `CONTACT_EMAIL`, it
  correctly answers `412` — set the address instead of debugging the form.

## Step 4 · Deploy (pick one)

### Option A — Cloud (simplest)

- API + Postgres on one container host (Fly.io, Railway, Hetzner + Coolify, …). Dockerfiles ship
  in each app; or managed Postgres + the API container.
- Sites + optional app SSR on Cloudflare: `bun run --cwd apps/site deploy:cloudflare`, the same for
  `apps/docs` (each needs its own `SITE_URL`), and `apps/web` with `ADAPTER=cloudflare`.

### Option B — Self-host everything (one VPS)

```sh
# one-time (Ubuntu/Debian): Docker, Tailscale, a `deploy` user, ufw, the clone, .env with secrets
curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/infra/scripts/provision.sh \
  | sudo REPO_URL=https://github.com/<you>/<repo>.git EXPOSE=tailscale bash   # or EXPOSE=public

# then, from the clone, as the deploy user — COMPOSE_FILE is in .env, so no -f
# provision.sh generated BETTER_AUTH_SECRET / POSTGRES_PASSWORD / SERVICE_TOKEN and set CADDY_MODE;
# you still fill DOMAIN (public) or WEB_URL + API_URL (tailnet)
docker compose up -d --build

# the first platform administrator, from the checkout (provision.sh installed Bun for `deploy`
# and wrote a DATABASE_URL for the compose Postgres on 127.0.0.1:5433 into .env)
bun install
ADMIN_PASSWORD='Something-Strong-123' bun run admin:create -- --email you@example.com --name 'You'
```

- `CADDY_MODE=subdomains` (public): `DOMAIN`, `docs.`, `app.`, `api.` with automatic HTTPS. Set
  `COOKIE_DOMAIN=.yourdomain` so the session spans `app.` and `api.`.
- `CADDY_MODE=single-origin` (tailnet/LAN or Tailscale Funnel, what `EXPOSE=tailscale` provisions):
  one host, path routing. Set `WEB_URL` and `API_URL` to that same origin → no CORS issues. Docs at
  `/docs`.
- Backups from day one (`COMPOSE_PROFILES=backup` is already in the provisioned `.env`) — take one
  now, do not wait for 02:30:
  ```sh
  docker compose run --rm backup bun src/cli.ts backup
  docker compose run --rm backup bun src/cli.ts list                    # exits 1 on a stale set
  docker compose run --rm backup bun src/cli.ts restore latest --drill  # checksum + row counts
  ```
  Set `BACKUP_S3_BUCKET` (or reuse the uploads bucket) so copies leave the box, and
  `BACKUP_HEARTBEAT_URL` so a missed night pages you. `list` exits 1 when the newest set is older
  than `BACKUP_MAX_AGE` (36 h) — that is the command for a cron or a health check, and
  `--no-max-age` turns the check off. A **real** restore re-hashes the dump against the manifest's
  `sha256` (a mismatch is never overridable), refuses a database-name mismatch
  (`--force-database-mismatch`) and refuses to run while writers are connected
  (`docker compose stop api worker`, or `--terminate-connections`); it then runs
  `--single-transaction --exit-on-error` under `BACKUP_LOCK_TIMEOUT`. The dump is **plaintext**, so
  harden the bucket: versioning or object lock, a write-only credential, pruning by lifecycle rule,
  server-side encryption. Runbook: `infra/README.md`.
- CI deploys: the Deploy workflow pushes images to GHCR on `main`. Set `DEPLOY_HOST` +
  `DEPLOY_SSH_KEY` and it runs `infra/scripts/deploy.sh` on the server after each build. The `caddy`
  image bakes the two static sites' canonical URLs at build time, so it needs four repository
  variables — `SITE_URL`, `DOCS_URL`, `WEB_URL`, `API_URL` — and the build fails naming them if they
  are missing.
- Pulling those images instead of building on the box
  (`docker login ghcr.io && docker compose pull && docker compose up -d`) needs `IMAGE_REGISTRY` to
  point at **your** fork's namespace (`provision.sh` derives it from `REPO_URL`; `deploy.sh` pins what
  CI passed) and, while the packages are private, a token with `read:packages`.

## Step 5 · Launch checklist

- [ ] Production `.env`: real `BETTER_AUTH_SECRET` and `SERVICE_TOKEN`, a `COOKIE_DOMAIN` that is a
  bare hostname covering both `WEB_URL` and `API_URL`, `TRUSTED_ORIGINS`, `RESEND_API_KEY` +
  `EMAIL_FROM` (on a domain you verified) + `CONTACT_EMAIL`. The API refuses to boot in production
  without the email provider, a real sender domain or a service token, and it names the variable —
  so the first `docker compose up` is the check.
- [ ] OAuth callbacks registered for the production API origin.
- [ ] Legal pages reviewed, contact email monitored.
- [ ] Backups scheduled, one restore drill (`restore latest --drill`), `list` wired into a cron or a
  health check, and the backup bucket hardened (versioning, a write-only credential, a lifecycle
  rule, server-side encryption).
- [ ] Sentry + uptime monitoring (e.g. Better Stack, or `COMPOSE_PROFILES=monitoring` in `.env`)
  watching `/readyz`.
- [ ] First backup + restore drill; `BACKUP_S3_*` or an off-box copy of the `backups` volume.
- [ ] `REQUIRE_EMAIL_VERIFICATION` left default (on in production).

---

## Command cheat sheet

| Command | What it does |
| --- | --- |
| `bun run dev:app` | API (:3000) + web app (:5173) — daily driver |
| `bun run dev` | Everything with a dev script (adds site :4321, docs :4322) |
| `bun run dev:site` / `dev:docs` | Just the marketing site / docs |
| `bun run dev:desktop` | Tauri desktop shell on the dev server, with HMR (needs Rust; keep `dev:app` or `dev:api` running) |
| `bun run preview:desktop` / `build:desktop` | The shell as it ships (debug window over the static build) / installers in `apps/native/src-tauri/target/release/bundle` |
| `bun run db:up` / `db:down` | Start / stop local Postgres |
| `bun run db:migrate` / `db:studio` | Apply migrations / browse the DB |
| `bun run admin:create -- --email … [--name …] [--yes]` | Create / bootstrap a platform admin (password from `ADMIN_PASSWORD` or a prompt) |
| `bun run licenses` | Dependency-licence audit; `--strict` is CI's gate and `THIRD-PARTY.md` is the write-up |
| `bun run rename` | Rename the kit to your product (dry run without `--write`) |
| `bun run verify` | The CI pipeline, locally: lint, typecheck and tests in CI's order |
| `bun run check` / `test` / `lint` / `build` | The same steps one at a time (`test` installs Playwright's Chromium on first run) |
| `bun run test:e2e` | Playwright: production preview, axe a11y, locale checks |
| `bun run auth:schema` then `db:generate` | After changing auth plugins (then `db:migrate`) |
| `bun run api:openapi` | Regenerate `apps/api/openapi.json` |
| `bunx shadcn-svelte@latest add <name> -c packages/ui` | Add a UI component (then export it) |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Port taken (`3000`/`5173`) after closing a terminal | The old `bun`/`vite` tree survived — kill it (Task Manager on Windows: end the `bun.exe` / `node.exe` under it), then `bun run dev:app` again |
| `db:up` fails / port `5433` busy | Set `POSTGRES_PORT=5434` in root `.env` (and in `DATABASE_URL`), `bun run db:up` again |
| `/api/auth/*` 500s after editing auth | `bun run auth:schema && bun run db:generate && bun run db:migrate`, restart `dev:app` |
| Changed a `packages/*` file, API didn't pick it up | Restart `dev:app` — `--hot` watches `apps/api` only, and `--env-file` is read at start |
| Contact form / Scalar show CORS errors | Site/docs origin must be in `TRUSTED_ORIGINS` (dev `:4321`/`:4322` are automatic; production isn't) |
| Emails don't arrive | Empty `RESEND_API_KEY` = console only (check the API terminal). With Resend set, verify the domain + `EMAIL_FROM` |
| Social button missing | Both `*_CLIENT_ID` *and* `*_SECRET` must be set, and the callback URL registered with the provider |
| Astro build needs network | First `apps/site` build fetches the OG-image font — expected |
| `astro build` fails with "SITE_URL is not set" (or "still the placeholder") | Deliberate: set that site's own canonical origin in `apps/site/.env` / `apps/docs/.env` or in the build environment. `example.com` is refused — it would ship canonicals, OG images, RSS links and a sitemap pointing at a domain you do not own |
| `db:migrate` exits 1 with "still pending after the run" | A merge interleaved migration timestamps and Drizzle skipped a file older than the newest applied one. Regenerate those so they sort last, or apply them by hand |
| `0007_audit_constraints` fails on a database that has been live | Deliberate: it adds constraints the app already assumed and will not delete rows to make them fit. Postgres names the offending key, and the migration's header comment carries the query that finds each duplicate. De-duplicate, then re-run |
| Sign-in "succeeds" but the session never sticks | `COOKIE_DOMAIN` must be a bare hostname (`.example.com`, not a URL) covering both `WEB_URL` and `API_URL`; anything else is dropped by the browser without a word. The API now refuses to boot on it instead |
| The API refuses to boot in production | It names the variable: no `RESEND_API_KEY`, an `EMAIL_FROM` on localhost / example / a dotless domain, no `SERVICE_TOKEN`, or a `COOKIE_DOMAIN` that does not cover both origins |
| Upload `PUT` fails with a CSP error in the browser or the desktop app | Set `PUBLIC_STORAGE_ORIGIN` to the bucket's origin and rebuild — the policy is derived at build time from the `PUBLIC_*` values |
| An upload answers `413`, or `411` | The body is over `MAX_UPLOAD_BYTES` (Caddy also caps `/uploads/*` at 32 MB and everything else at 1 MB), or the `PUT` arrived without a `Content-Length` |

## Where to go next

- `README.md` — what Starterdough is and why it's built this way
- `apps/web/README.md`, `apps/site/README.md`, `apps/docs/README.md` — per-app details
- `docs/DECISIONS.md` — the 30 architecture decision records (the "why" behind every choice)
- `infra/README.md` — hosting, Caddy modes, Tailscale, backups, Cloudflare notes
- `LICENSE.md` — what you may do with the kit · `THIRD-PARTY.md` — what it depends on and the two
  notices that travel with anything you ship · `CHANGELOG.md` and `UPGRADING.md` — what changed per
  release, and how to merge one into your renamed fork · `SECURITY.md` — reporting a vulnerability
- Live API surface: http://localhost:3000/api/v1/openapi.json (Swagger-style via `/docs` → API reference)
