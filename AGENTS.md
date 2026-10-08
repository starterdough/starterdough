# AGENTS.md

Instructions for coding agents working in this repository: what it is, the commands, and the rules
the code relies on. `CONTRIBUTING.md` and `docs/DECISIONS.md` give the reasons behind them.

## What this is

A Bun-native SaaS starter and the product built on it: a SvelteKit app, one contract-first HTTP API
(Hono + oRPC: one contract gives typed RPC, REST and OpenAPI), an Astro marketing site and Starlight
docs, Tauri desktop and mobile shells, and a self-hosting stack. Postgres 17 through Drizzle is the
only store, and only the API touches it. Every other app is a thin client of the API.

## Layout

- `apps/web`: the SvelteKit 3 app (Svelte 5, Tailwind 4), a thin client of the API.
- `apps/api`: the API, Hono on Bun. Hosts Better Auth and the oRPC router (`src/rpc/`).
- `apps/site`, `apps/docs`: the Astro marketing site and the Starlight docs. Static, English only.
- `apps/native`: Tauri 2 desktop and mobile shells around `apps/web`'s static build. No IPC.
- `packages/api-contract`: the oRPC + Zod contract the API implements and every client calls.
- `packages/api-client`: the typed client for that contract, and the schemas frontends share.
- `packages/auth`: Better Auth's server (API only), its browser client, and `src/permissions.ts`.
- `packages/db`: Drizzle schema, migrations (`drizzle/`), query helpers and the Bun SQL client.
- `packages/env`: the API's environment, validated once at start-up (t3-env + Zod).
- `packages/email`: the email provider (Resend, or the console in development) and templates.
- `packages/ui`: shared Svelte components and Tailwind tokens. Its README maps every export.
- `packages/tsconfig`: shared TypeScript configs.
- `infra`: the self-hosted Compose stack, Caddy, backups, provision and deploy scripts.
- `scripts`: repository tooling: `setup`, `doctor`, `rename`, `licenses`.

## Commands

```sh
bun install                    # dependencies, git hooks, SvelteKit's generated types
bun run setup                  # every .env from the .env.example next to it; safe to rerun
bun run doctor                 # read-only check of the local setup
bun run db:up                  # Postgres 17 in Docker on 127.0.0.1:5433
bun run db:migrate             # apply packages/db/drizzle; exits 1 if one is still pending
bun run dev:app                # API on :3000, web on :5173 (`bun run dev` adds site and docs)

bun run lint:fix               # Biome: format and fix; never format by hand
bun run lint                   # the same check, without writing
bun run check                  # typecheck every app and package
bun run test                   # unit and component tests, without a database
bun run verify                 # lint + check + test in CI's order; the pre-push hook runs it

bun run db:generate            # a migration from your schema change, then db:migrate
bun run db:generate --custom --name=<name>   # an empty one, for SQL the schema cannot hold
bun run auth:schema            # regenerate Better Auth's tables after changing its config
```

With an existing Postgres instead of Docker, point `DATABASE_URL` in `.env` at a development
database, run `bun run doctor -- --database=external`, and skip `db:up`.

Faster gates while you iterate: `bun run --cwd apps/web check`, `bun run --cwd packages/db test`,
`bunx biome check --write <files>`. `bun run test:e2e` runs the Playwright suites; run it when you
touch routing, forms or the app shell.

- Migrations in `packages/db/drizzle/` are generated and append-only. Never edit or delete one that
  has been applied anywhere, and never edit `drizzle/meta/`: fix forward with a new migration.
  There is no `db:push`; every schema change goes through a migration, in development too.
- Name a new test that needs Postgres `*.db.test.ts` and skip it unless both `DATABASE_URL` and
  `RUN_DB_TESTS=1` are set, as `CONTRIBUTING.md` shows; CI's database job runs every such file.
  Run one with `RUN_DB_TESTS=1 DATABASE_URL=postgres://… bun test <file>`.
- The SQL tests already in `packages/db` gate on `DATABASE_URL` alone: they run whenever it is
  set, and `bun test` run from the repository root loads it from `.env`. They touch only
  temporary tables. `bun run --cwd packages/db test:db` runs them against the `DATABASE_URL` in
  `.env`. Point any database test at a development database you can throw away, never at shared
  or staging data.

## Rules the code relies on

- **One API, contract first.** A procedure is declared in `packages/api-contract` (input, output,
  errors and an explicit `route`, so it is also REST under `/api/v1` and in the OpenAPI document),
  implemented in `apps/api/src/rpc/`, and called through the typed client. A feature's contract can
  live in its own file, `packages/api-contract/src/<feature>.ts`, built with the builders
  `src/procedures.ts` exports. No second API, no Tauri IPC, no SvelteKit form actions.
- **Frontends never import server packages.** `apps/web` and `apps/site` never import `@repo/db`,
  `@repo/auth/server` or `@repo/env`; they use `@repo/api-client`, `@repo/auth/client`,
  `@repo/auth/permissions` and `@repo/ui`.
- **Authorize in the API.** A procedure that is not public runs on `authed` (signed in) or
  `adminOnly` (platform admin) from `apps/api/src/rpc/base.ts`. Hiding UI is not a check.
- **Every user-visible string in `apps/web` is a Paraglide message** in both
  `apps/web/messages/{en,de}/<area>.json` (keys `<area>_<page>_<element>`, sorted), rendered with
  `m.key()` from `#lib/paraglide/messages.js`. Plurals are variants, never concatenation. Call
  `m.…()` inside a function, never in a module-level constant, which the server evaluates once.
- **Validation rules live in the contract, their copy in the UI.** A form validates the
  contract's schema (re-exported from `@repo/api-client`) through `zodForm(schema)` and `spaForm`
  from `#lib/forms.js`, never a copy. A rule the UI must phrase carries `params: { reason }`,
  mapped in `issueMessage` there. Schemas without a procedure go in `#lib/schemas.js`, with lazy
  messages: `{ error: () => m.key() }`.
- **Stored text and JSON.** Free text in the contract refuses control characters, U+0000 included
  (`isSingleLine`, or `isPlainText` for multi-line text, with `controlCharacterRule`). A JSON column
  uses `jsonb` from `packages/db/src/schema/jsonb.ts`, never drizzle-orm's `jsonb()` or `json()`.
- **Environment.** The API and the packages read variables only through `@repo/env`, which
  validates them at start-up: add a new one to `packages/env/src/index.ts` and to the
  `.env.example` its process reads. `apps/web` declares its own in `apps/web/src/env.ts` and
  imports them from `$app/env/public` or `$app/env/private`.
- **Generated files are regenerated, never edited:** `packages/db/src/schema/auth.ts` (change
  `packages/auth/src/server.ts` and run `bun run auth:schema` on its own: it fails until you re-add
  the hand-added constraints it names, which `git diff` shows. Check them with
  `bun packages/db/src/schema/auth-constraints.ts`, not by re-running it, then run
  `bun run db:generate` and do not apply a migration that drops any of them),
  `packages/db/drizzle/meta/`, `apps/web/src/lib/paraglide/`
  (compiled from `apps/web/messages/`), `apps/web/.svelte-kit/`, `apps/api/openapi.json`
  (`bun run api:openapi`), `apps/native/src-tauri/gen/` (the Tauri CLI) and `bun.lock`.
- **Biome formats and lints** (tabs, single quotes, 100 columns); the pre-commit hook formats what
  you stage. Do not reformat kit files you are not otherwise changing. No `any`, no `@ts-ignore`;
  a `biome-ignore` names its rule and its reason.
- **Tests sit next to the code:** `*.test.ts` for `bun test` (packages, API); `*.spec.ts` and
  `*.svelte.spec.ts` (components, in Chromium) for Vitest in `apps/web`; Playwright in
  `apps/web/e2e`. Size a test like its neighbours, and test the failure you are closing.
- **No secrets in code**, tests or an `.env.example`. Local values live in the untracked `.env`
  files `bun run setup` writes; production's are encrypted in `infra/env/` (SOPS). Never log one.
- **No new dependency** for what a few lines of standard library do. After adding one, run
  `bun run licenses --strict` and record its licence in `THIRD-PARTY.md`.

## Adding a feature

In this order, with new code in new files where you can:

1. **Schema.** `packages/db/src/schema/<feature>.ts`, exported from that directory's `index.ts`;
   queries in `packages/db/src/<feature>.ts`. `db:generate`, read the SQL, `db:migrate`.
2. **Contract.** Schemas and procedures, each with a `route`, in `packages/api-contract`.
   Re-export what the web app needs from `packages/api-client/src/index.ts`.
3. **Implementation.** A router in `apps/api/src/rpc/<feature>.ts` on `authed` or `adminOnly`,
   mounted in `router.ts`.
4. **UI.** Routes under `apps/web/src/routes/`, data through `api` (`#lib/api.js`) or TanStack
   Query (`orpc`, `#lib/query.js`), forms through `zodForm`, strings in English and German.
5. **Tests** next to each layer, then `bun run verify`.

`apps/docs/src/content/docs/guides/feature-example.md` follows a global, admin-managed feature
(feature flags) through the same layers, with its tests.

## Read more

- `QUICKSTART.md`: from a fresh clone to a running app, then accounts, keys and deployment.
- `UPGRADING.md`: how kit releases are merged into this repository. It is why you put your code in
  new files where you can and leave kit files' formatting alone: a new file never conflicts.
- `CONTRIBUTING.md`: the dev loop and the ground rules in full.
- `docs/DECISIONS.md`: one record per architecture decision, with the alternatives not taken. Read
  it before changing the stack; a new decision is a new entry.
- `apps/docs/src/content/docs/`: guides, the API and command reference, every environment variable.
- The README in each app, in `infra` and in `packages/ui`.
