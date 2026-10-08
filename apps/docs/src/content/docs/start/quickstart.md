---
title: Quickstart
description: From a clone to a running API and app in a few commands.
---

The setup guide is `QUICKSTART.md` at the root of the repository, the one copy kept up to date. It
takes a fresh clone to a running app in about ten minutes, then covers the first administrator,
the accounts and keys you need next, deployment and the launch checklist. This page is its
outline; where the two differ, `QUICKSTART.md` is right.

## Install and run

You need Bun 1.4 or newer, and Docker with Compose and a running daemon for the local Postgres, or
an existing Postgres 17 instead of Docker. Rust is only for the Tauri shells. Node.js is optional,
but if it is installed it must be 22.17 or newer: Vite runs under it.

Start from a release, not from the kit's `main`: `UPGRADING.md`'s first block checks out the
release you name (name the newest: `git tag -l "kit/*" --sort=-v:refname` lists them) and files the
kit's tags under `kit/`, which later upgrades merge from. Then:

```sh
bun install
bun run setup        # every .env from its template, with generated secrets
bun run doctor       # read-only: prerequisites and configuration
bun run db:up        # Postgres 17 in Docker on 127.0.0.1:5433
bun run db:migrate
bun run dev:app      # API on :3000, app on http://localhost:5173
```

Without Docker, point `DATABASE_URL` in the root `.env` at a development database on your own
Postgres, run `bun run doctor -- --database=external` instead of `bun run doctor`, and skip
`db:up`. The doctor then skips its Docker checks; it does not install or configure Postgres.

Rename the kit before `setup` if you already have a product name, on the branch `UPGRADING.md` names
so later releases merge cleanly (`QUICKSTART.md`, Step 1, item 2). `setup` never replaces a value
you set, so it is safe to run again. It also gives the marketing site and the docs their local
`SITE_URL`, so `bun run build` works on a fresh clone.

[Configuration](/start/configuration/) explains every variable, and [Commands](/reference/commands/)
lists every command. When you add your first feature, follow
[the worked feature example](/guides/feature-example/).

## First steps in the app

1. **Sign up** at `/signup` with email and password. In development the verification email prints
   to the API terminal. `REQUIRE_EMAIL_VERIFICATION` decides whether a session is issued before the
   address is verified (default: only in production).
 2. **Set up your account** from `/app/settings` (profile, email, password). Add two-factor
    authentication or a passkey from `/app/settings/security`.

## First platform administrator

Platform administrators are users whose `role` is `admin`. Promote the account you created during
signup, then manage others from `/admin/users`:

```sh
bun run admin:create -- --email you@example.com --name 'You' --yes
```

`--yes` confirms promotion of the existing account and leaves its password unchanged. For a new
email, the script creates the account and reads its password from `ADMIN_PASSWORD` or an interactive
prompt. The password is never read from a command-line argument, because arguments stay in shell
history and are visible in `ps`.

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
