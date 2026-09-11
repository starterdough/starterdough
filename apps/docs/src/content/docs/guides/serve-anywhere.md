---
title: Serve anywhere
description: The same code as a website, a PWA, a desktop app, a mobile app, and a self-hosted stack reachable through Tailscale.
---

Three ways to run the same code. Pick per environment; nothing in the apps changes.

| | Where | What runs there | Notes |
| --- | --- | --- | --- |
| **Cloud** | Cloudflare | `apps/site`, `apps/docs` (static assets), `apps/web` (Workers, SSR) | `bun run --cwd apps/<app> deploy:cloudflare` per app; `wrangler.jsonc` included |
| | One container host (Fly.io, Railway, Hetzner + Coolify, …) | `apps/api` and Postgres | Dockerfiles in each app; managed Postgres or the compose one |
| **Self-hosted** | Your VPS / home server | everything, via `infra/compose.yml` | Caddy in front; Tailscale for private or public access |
| **Local** | Your machine | `bun run dev` + `compose.dev.yml` (Postgres) | Tauri shell via `bun run dev:desktop` |

## The targets

| Target | How | Notes |
| --- | --- | --- |
| **Website** | `apps/site` + `apps/docs` → Cloudflare (or Caddy). `apps/web` → Cloudflare Workers (`ADAPTER=cloudflare`) or a container (`ADAPTER=node`) | The API runs on a container host (Bun.SQL, long-lived connections) |
| **Mobile site / PWA** | Same `apps/web`; manifest, `theme-color`, service worker with a prerendered offline page | Registered in production browsers only |
| **Desktop app** | `apps/native` → `bun run build:desktop` builds `apps/web` with `ADAPTER=static` and bundles installers | Auth switches to bearer tokens automatically. Needs `PUBLIC_API_URL` **and** `PUBLIC_WEB_URL`; add `PUBLIC_STORAGE_ORIGIN` when uploads go to a bucket |
| **Mobile app** | Same Tauri project: `android:init` / `ios:init`, then `android:build` / `ios:build` | Or point `frontendDist` at the hosted app URL for a thin client |
| **Self-hosted (VPS / home server)** | `docker compose up -d --build` from the repository root (`COMPOSE_FILE` is in `.env`) | Caddy in `subdomains` (public TLS) or `single-origin` mode (path routing) |
| **Anywhere access, incl. your phone** | Tailscale on the host: `tailscale serve --bg 80` (tailnet) or `tailscale funnel --bg 80` (public) | No open ports, HTTPS handled |

## One web build, three adapters

`apps/web` builds for Node (`adapter-node`), Cloudflare Workers (`adapter-cloudflare`) or as a
static SPA (`adapter-static`) with one variable. These are the web app's own scripts — run them
from `apps/web`, or with `--cwd` from the repository root:

| Command | Adapter | Use |
| --- | --- | --- |
| `bun run --cwd apps/web build` / `build:node` | `adapter-node` | Self-hosted container (`apps/web/Dockerfile`) |
| `bun run --cwd apps/web build:cloudflare` | `adapter-cloudflare` | Cloudflare Workers (`wrangler.jsonc`) |
| `bun run --cwd apps/web build:static` | `adapter-static` (SPA) | Any static host — writes to `build/` |
| `bun run --cwd apps/web build:static:desktop` | `adapter-static` (SPA) | What the Tauri shell builds: the same SPA with `STATIC_OUT_DIR=build-static`, so it gets a directory of its own |

(The root `bun run build` builds every app through Turborepo, `apps/web` with its default adapter.)

The static build sets `ssr = false` and switches auth from cookies to bearer tokens. Because the
app holds no business logic, every route works as SSR *and* as SPA — that is what makes the shells
cheap.

## Desktop and mobile — Tauri 2, no IPC

`apps/native` is a Tauri 2 project for Windows, macOS, Linux, Android and iOS. The shell loads the
static build of `apps/web`, and the frontend talks to the API over HTTPS exactly like the browser.
The Rust side is small and only grows for native capabilities the web platform lacks (tray,
autostart, deep links, updater, notifications, biometrics) — as Tauri plugins, never as a data layer.

```sh
# root scripts
bun run dev:desktop                       # starts the SvelteKit dev server and opens the shell
bun run build:desktop                     # builds apps/web into build-static, then bundles installers

# the mobile targets and the icon generator live in apps/native only
bun run --cwd apps/native android:init    # once, then android:dev / android:build
bun run --cwd apps/native ios:init        # once (macOS), then ios:dev / ios:build
bun run --cwd apps/native icons           # regenerate platform icons from ../web/static/icons/icon-512.png
```

Two ways to ship the frontend:

1. **Bundled (default)** — `frontendDist: ../../web/build-static`, which the shell's
   `beforeBuildCommand` fills by running `bun run --cwd ../web build:static:desktop`. It is a
   directory of its own (gitignored) because `build/` is where the node and Cloudflare adapters
   write: sharing it meant a desktop build silently overwriting a server build, and the other way
   round. The API URL is baked in via `PUBLIC_API_URL` at build time.
2. **Remote (thin client)** — set `frontendDist` to `https://app.example.com` and grant that origin
   in a capability (`remote.urls`). Ship the app once, update the frontend by deploying the web app.

Prerequisites: the Rust toolchain (`rustup`), the platform dependencies listed by Tauri, and for
mobile Android Studio + NDK or Xcode (iOS, macOS only).

`build:desktop` refuses to start unless `PUBLIC_API_URL` **and** `PUBLIC_WEB_URL` are set to
something that is not a placeholder — a release built without them would silently ship installers
bound to `api.example.com`. `PUBLIC_WEB_URL` is where external round trips return to, because
the webview's own origin (`tauri.localhost`) is not an address any provider can redirect to; with it
unset those buttons are hidden rather than dead-ending the user in the system browser. Add
`PUBLIC_STORAGE_ORIGIN` whenever uploads go to S3/R2: the shell's `connect-src` is generated from
exactly these values (`apps/native/scripts/tauri-config.ts` reads `apps/web/.env`, `.env.local`,
`.env.production` and `.env.production.local` in Vite's own order, process environment last), so
without the bucket origin every presigned upload fails the policy.

**Releasing.** Bump `version` in the root `package.json` — the single source of truth, from which the
generator writes `src-tauri/Cargo.toml`, `apps/native/package.json` and the Tauri config, so
`Cargo.lock` moves with it — then push a `v<version>` tag. `.github/workflows/desktop.yml` builds
Windows, macOS (both architectures) and Linux, and a final job that needs the whole matrix collects
the artifacts into one **draft** release, so a partial installer set can never reach a release. The
tag must equal the root version exactly, or the run fails before anything is built. Its repository
variables are the same `PUBLIC_*` names.

When a user reports "it opens and closes again", ask for the log:
`%LOCALAPPDATA%\dev.starterdough.native\logs\Starterdough.log` on Windows,
`~/Library/Logs/dev.starterdough.native` on macOS, `$XDG_DATA_HOME/dev.starterdough.native/logs` on Linux —
plus `dev.starterdough.native-startup-error.txt` in the temp directory when the failure came before the
window existed.

## Self-hosting with Docker Compose

```sh
# from the repository root — COMPOSE_FILE=infra/compose.yml is in .env, so no -f
cp .env.example .env   # DOMAIN, CADDY_MODE, secrets; or WEB_URL + API_URL for a tailnet host
docker compose up -d --build
```

Migrations run on every `up` (`migrate` one-shot). Two Caddy modes, selected with `CADDY_MODE`:

- **`subdomains`** (public): `DOMAIN`, `docs.DOMAIN`, `app.DOMAIN`, `api.DOMAIN` with automatic
  HTTPS. Set `COOKIE_DOMAIN=.DOMAIN` so the session cookie spans `app.` and `api.`.
- **`single-origin`** (tailnet/LAN): path routing on one host, TLS terminated by Tailscale. Set
  `WEB_URL` and `API_URL` to that same origin → no CORS, plain same-site cookies. Docs live at `/docs`.

The Astro sites are built into the Caddy image by `infra/docker/Dockerfile.static`. The runbook
(backups, deploy, traces, secrets) is [Operations](/guides/operations/) and `infra/README.md`.

## Tailscale: reach it from anywhere, including your phone

Install Tailscale on the server (host, not container) and on your devices, then:

```sh
# private — only devices on your tailnet
tailscale serve --bg 80
# public — no open ports, no DNS, Let's Encrypt handled by Tailscale
tailscale funnel --bg 80
```

Both give you `https://<machine>.<tailnet>.ts.net`. Use `CADDY_MODE=single-origin` and set `WEB_URL`
and `API_URL` to `https://<machine>.<tailnet>.ts.net` (compose derives the app's `PUBLIC_API_URL`
from `API_URL`). On the phone, install the
Tailscale app once; the PWA or the Tauri build then works on the go.

Alternatives: Cloudflare Tunnel (`cloudflared`) for public access without ports; a Tailscale sidecar
container (`tailscale/tailscale` image with `TS_SERVE_CONFIG`) if you prefer everything in compose.

## Cloudflare notes

- Astro sites: static assets on Workers (`wrangler.jsonc` in `apps/site` and `apps/docs`;
  `bun run --cwd apps/site deploy:cloudflare`, same for `apps/docs`). Each build needs that app's
  own `SITE_URL` — a build without one fails rather than shipping `example.com` canonicals.
- SvelteKit: `ADAPTER=cloudflare` → `@sveltejs/adapter-cloudflare` (Workers static assets + SSR).
- The API stays on a container host: it uses Bun-native `Bun.SQL`, long-lived Postgres connections
  and Better Auth's full feature set, which do not fit Workers well. If you ever want the API at the
  edge, use Hyperdrive for Postgres pooling and swap `drizzle-orm/bun-sql` for
  `drizzle-orm/postgres-js`.

## Backups

Profiles are selected in `.env`, never on the command line — `infra/scripts/deploy.sh` runs
`up --remove-orphans`, which would drop the containers of every profile not named in that one
invocation:

```sh
echo 'COMPOSE_PROFILES=backup' >> .env
docker compose up -d
docker compose run --rm backup bun src/cli.ts backup
docker compose run --rm backup bun src/cli.ts restore latest --drill
```

The `backup` service writes a custom-format `pg_dump` plus, with the local storage driver, a
tarball of the uploads, copies both to S3/R2 when a bucket is set, prunes old sets and pings
`BACKUP_HEARTBEAT_URL`. Details: [Operations](/guides/operations/) and `infra/backup/README.md`.

A real restore (`restore <stamp> --yes`) re-hashes the dump against its manifest, refuses a database
name that does not match the target, and refuses to run at all while other sessions are connected —
stop the writers (`docker compose stop api worker`) or pass `--terminate-connections`. `list` exits 1
when the newest set is stale. [Operations → Backups](/guides/operations/#backups) has the whole
sequence and every flag.
