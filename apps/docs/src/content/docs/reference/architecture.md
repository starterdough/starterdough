---
title: Architecture
description: The one rule, the diagram, how a request flows, the repository map and the hard rules that keep every surface a thin client.
---

## The one rule: a single source of truth over HTTP

Every surface is a **thin client of one HTTP API**. The SvelteKit app, the Tauri desktop and mobile
shells, the Astro sites' dynamic bits and CLIs all consume the same `apps/api` — the same auth, the
same procedures, the same OpenAPI document. No Tauri IPC, no per-platform data layer, no
duplicated business logic.

```
 Public (Astro, static)      Application (SvelteKit, one codebase)   Native shells (Tauri 2, no IPC)
 ┌─────────────────────┐     ┌──────────────────────────────────┐    ┌────────────────────────────┐
 │ apps/site           │     │ apps/web · SSR (Node/Cloudflare) │    │ Desktop · Win, macOS, Linux│
 │ apps/docs           │     │ apps/web · static SPA ───────────┼───▶│ Mobile  · Android, iOS     │
 └──────────┬──────────┘     │ PWA install                      │    └─────────────┬──────────────┘
            │ optional       └────────────────┬─────────────────┘                  │ HTTPS + bearer
            ▼                                 ▼ HTTPS (cookie)                     ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ apps/api — Hono on Bun                                                                         │
 │ Better Auth (/api/auth/*) · oRPC: RPC (/rpc/*) + REST/OpenAPI (/api/v1/*)                      │
 └──────────────────────┬─────────────────────────────────────────────────────────────────────────┘
                        │ Drizzle (Bun.SQL)
                        ▼
              ┌──────────────────┐
              │ Postgres 17      │
              └──────────────────┘
```


### Consequences you feel every day

 - **Add a feature once.** Declare it in `packages/api-contract`, implement it in `apps/api`, call
   it from any client with full types (`api.account.me()`). REST + OpenAPI come for free.
- **Ship the frontend anywhere.** `apps/web` builds for Node, Cloudflare Workers or as a static SPA
  with one env var: `ADAPTER=…`.
- **Auth is transport-aware, not platform-aware.** Browsers use an httpOnly cookie; the Tauri shells
  use a bearer token. The UI code is identical.
- **The database has exactly one client.** Only the API touches Postgres (Bun's native `Bun.SQL`
  through Drizzle). Frontends cannot reach it even by accident.

## How a request flows

 1. A Svelte component calls `api.account.me()` (`packages/api-client`).
 2. The oRPC link POSTs to `${PUBLIC_API_URL}/rpc/account/me`. In the browser the session cookie
    rides along (`credentials: include`); in a Tauri shell `Authorization: Bearer …` is attached
    from `localStorage`. During SSR, `hooks.server.ts` rewrites the origin to the internal
    `API_URL` and forwards the browser's cookies.
3. Hono routes to the oRPC handler; `requireAuth` resolves the session via Better Auth
   (`auth.api.getSession`) and the procedure runs against Drizzle.
 4. The same procedure is reachable as `GET /api/v1/me` and documented at
    `/api/v1/openapi.json` — that is what curl and third parties use.

## Hard rules

These are the rules the codebase is built around. Breaking one usually means a second source of
truth is being created.

 1. **Frontends never import server packages.** `@repo/db`, `@repo/auth/server` and `@repo/env`
    are never imported by `apps/web` or `apps/site`. The browser-safe surfaces are
    `@repo/auth/client`, `@repo/auth/permissions`, `@repo/api-client` and `@repo/ui`.
2. **Contract first.** No endpoint without a contract entry; no client without the typed client.
   A new feature is: contract in `packages/api-contract` → implementation in
   `apps/api/src/rpc/router.ts` → the UI calls the typed client. REST and OpenAPI follow.
3. **No Tauri IPC.** The shells have no commands and no data layer; they use the same HTTP client
   as the browser. Native capabilities are added as Tauri plugins.
4. **SSR is rendering, not a backend.** `apps/web` has no server-side business logic; `load`
   functions call the API. No form actions — forms validate the contract's schema and submit to the
   API, on every target.
5. **The session guard is universal.** Route protection is a universal `load` that works in SSR and
   in the static SPA, never a server-only layout load.
 6. **The UI learns capabilities from the API** (`system.authConfig`, `system.flags`) instead of
    mirroring server configuration into frontend env.
8. **Env is validated once** (`packages/env`); `SKIP_ENV_VALIDATION=1` only for steps that never
   boot the app.
9. **Generated code is regenerated, not edited** (`packages/db/src/schema/auth.ts`,
   `packages/db/drizzle/`).
10. **One formatter and linter** — Biome; tabs, single quotes, 100 columns.

## Repository map

```
apps/
  web/          SvelteKit application — auth, account, admin (thin client)
  api/          Hono on Bun — Better Auth, oRPC router (RPC + REST/OpenAPI)
  site/         Astro — marketing, blog, SEO
  docs/         Astro Starlight — product documentation
  native/       Tauri 2 — desktop + mobile shells around apps/web's static build (no IPC)
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
  compose.yml           self-hosted stack: postgres · migrate · api · web · caddy
                        (+ profiles: backup, monitoring, observability)
  compose.dev.yml       Postgres for local development
  caddy/                subdomains.Caddyfile (public) · single-origin.Caddyfile (tailnet/LAN)
  docker/               Dockerfile.static (Astro sites → Caddy)
  backup/               pg_dump, S3 copy, restore drill (`@repo/backup`)
  scripts/              provision.sh · deploy.sh
  env/                  production .env, encrypted (SOPS + age)
  loadtest/k6/          smoke.js
scripts/                licenses.ts (dependency-licence audit) · rename.ts (rename the kit)
docs/DECISIONS.md       architecture decision records (D1–D30)
LICENSE.md · THIRD-PARTY.md · CHANGELOG.md · UPGRADING.md · SECURITY.md · CONTRIBUTING.md
```

Internal packages are consumed **from source** (no build step): Bun runs TypeScript natively and Vite
compiles Svelte from the workspace. Versions of shared dependencies are pinned once in the root
`package.json` `catalog` and referenced with `catalog:`.

## Stack

| Layer | Choice | Why (short) |
| --- | --- | --- |
| Runtime · package manager · test runner | **Bun** | One tool for installs, scripts, the API runtime and tests |
| Task orchestration | **Turborepo** | Cached, graph-aware `build/check/test` |
| Lint · format | **Biome** | One config for TS/JSON/CSS + Svelte/Astro |
| Application UI | **SvelteKit 2 + Svelte 5** | Every route works as SSR *and* SPA |
| Public sites | **Astro 7** (+ Starlight) | Content, SEO, docs; static output |
| Styling | **Tailwind v4** | Shared tokens in `packages/ui/theme.css` as `light-dark()` pairs |
| UI kit | **shadcn-svelte** on **bits-ui** | Generated into `packages/ui`, one copy for every surface |
| Forms · client cache | **sveltekit-superforms** (SPA mode, Zod 4) · **TanStack Query** | Schemas shared with the contract; keys and fetchers derived from it |
| API | **Hono + oRPC** on Bun | Contract-first, end-to-end types, native OpenAPI 3.1 |
| Desktop · mobile shells | **Tauri 2** | System webview, small binaries, Android/iOS first-class |
| Edge · static hosting | **Cloudflare** Workers static assets | Astro sites + optional SvelteKit SSR |
| Server hosting | **Docker Compose + Caddy**, **Tailscale** | One container host or your VPS; private/public access |
| Database | **Postgres 17 + Drizzle** | SQL as the source of truth; Bun-native driver |
| Auth · admin | **Better Auth** | Admin, bearer, passkey, two-factor and OpenAPI plugins; Drizzle adapter |

Full reasoning, alternatives considered and the trade-offs live in `docs/DECISIONS.md` in the
repository.
