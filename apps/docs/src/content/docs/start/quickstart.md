---
title: Quickstart
description: From a clone to a running API and app in a few commands.
---

## Prerequisites

- **Bun 1.4 or newer**: runtime, package manager and test runner for the whole repository.
- **Docker**: runs the local Postgres.
- **Rust toolchain**: only for `apps/native` (the Tauri shells).

## Install and run

Every command below is the same in bash and in PowerShell.

1. Install dependencies and copy the env templates:

```sh
bun install
cp .env.example .env                 # API, db tooling, compose
cp apps/web/.env.example apps/web/.env
```

2. Generate `BETTER_AUTH_SECRET`. It ships empty, and the API refuses to boot without it. Put the
   output in `.env`:

```sh
bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

3. Start Postgres, apply the migrations and run the app:

```sh
bun run db:up                        # Postgres 17 in Docker (127.0.0.1:5433 by default)
bun run db:migrate                   # applies packages/db/drizzle/*.sql (exits 1 if any stay pending)

bun run dev:app                      # api on :3000 + web on :5173
```

Then open [http://localhost:5173](http://localhost:5173). The defaults in `.env.example` are enough
for local development: emails print to the API terminal and social sign-in stays off. See
[Configuration](/start/configuration/) for what each variable switches on.

### Other entry points

| Command | What |
| --- | --- |
| `bun run dev` | every app with a `dev` script (api, web, site `:4321`, docs `:4322`) |
| `bun run dev:desktop` | Tauri desktop shell around the dev server (needs Rust) |
| `bun run verify` | lint, typecheck and tests, in CI's order. Run it before every push |
| `bun run check` · `bun run test` · `bun run lint` · `bun run build` | the same steps one at a time, plus the build. `test` runs Svelte components in a real browser and installs Playwright's Chromium on first run |
| `bun run test:e2e` | Playwright against a production preview of `apps/web` |
| `bun run admin:create -- --email … [--name …]` | create the first platform administrator. The password comes from `ADMIN_PASSWORD` or a prompt |

The full list is in [Commands](/reference/commands/).

## First steps in the app

1. **Sign up** at `/signup` with email and password. In development the verification email prints
   to the API terminal. `REQUIRE_EMAIL_VERIFICATION` decides whether a session is issued before the
   address is verified (default: only in production).
 2. **Set up your account** from `/app/settings` (profile, email, password). Add two-factor
    authentication or a passkey from `/app/settings/security`.

## First platform administrator

Platform administrators are users whose `role` is `admin`. This role is independent of organization
roles. Create the first one from the command line, then promote others from `/admin/users`:

```sh
ADMIN_PASSWORD='…' bun run admin:create -- --email you@example.com --name 'You'
# add --yes to promote an account that already exists
```

With `ADMIN_PASSWORD` unset the script prompts for one. The password is never read from the command
line, because arguments stay in shell history and are visible in `ps`.

## Where things live

```
apps/
  web/          SvelteKit application: auth, account, admin (thin client)
  api/          Hono on Bun: Better Auth, oRPC router (RPC + REST/OpenAPI)
  site/         Astro: marketing, blog, SEO
  docs/         Astro Starlight: this documentation
  native/       Tauri 2: desktop + mobile shells around apps/web's static build (no IPC)
packages/
  api-contract/ oRPC + Zod contract: the API's single source of truth
  api-client/   typed client for the contract (browser, SSR, Tauri, Bun scripts)
  auth/         Better Auth server instance (API) and Svelte client factory (frontends)
  db/           Drizzle schema (generated auth tables + ours), migrations, Bun.SQL client
  email/        provider abstraction (Resend / console) + templates
  env/          validated server environment (t3-env + Zod)
  ui/           shared Svelte 5 components (shadcn-svelte/bits-ui + thin form wrappers) + Tailwind tokens
  tsconfig/     shared TypeScript configs
infra/
  compose.yml           self-hosted stack: postgres · api · web · caddy
  compose.dev.yml       Postgres for local development
  caddy/                subdomains.Caddyfile (public) · single-origin.Caddyfile (tailnet/LAN)
  docker/               Dockerfile.static (Astro sites → Caddy)
```

Internal packages are consumed from source. There is no build step. Shared dependency versions are
pinned once in the root `package.json` `catalog` and referenced with `catalog:`.
