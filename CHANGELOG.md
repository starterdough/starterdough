# Changelog

Every notable change to the kit, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version numbers follow
[semantic versioning](https://semver.org/spec/v2.0.0.html), where "breaking" means *breaking for a
buyer merging the release into their fork*: a moved file, a renamed export, a changed environment
variable, a migration that must be applied.

The version in the root `package.json` is the single source of truth — the site, the admin system
page and every artefact read it from there. [`UPGRADING.md`](UPGRADING.md) explains how to pull a
release into a renamed fork.

## [Unreleased]

### Added

- **Documents and jobs.** Presigned uploads through `@repo/storage` (local disk with HMAC URLs, or
  S3/R2/MinIO), a Postgres job queue claimed with `FOR UPDATE SKIP LOCKED` that runs inline or as a
  separate `bun run worker`, an AI-credit ledger with per-kind pricing, and `jobs.stream` as SSE.
  Documents and Jobs pages in the app, in English and German.
- **AI service.** An internal FastAPI service (`services/ai`) with `/v1/extract`, `/v1/summarize`
  and `/v1/embed` behind a provider seam — a local implementation by default, any OpenAI-compatible
  endpoint when `OPENAI_API_KEY` is set. Reachable only from the API, with `X-Service-Token`.
- **Search, OCR and quotas.** pgvector `document_chunk` rows, a `document.index` job, workspace
  search, OCR behind an image seam (Tesseract subprocess or OpenAI vision), and per-workspace
  storage quotas.
- **Operations.** Docker Compose for the whole stack with Caddy in subdomain or single-origin mode,
  a provisioning script for a fresh VPS, GHCR image builds and a deploy workflow, SOPS-encrypted
  secrets, a nightly backup tool (`pg_dump` plus the uploads volume, off-box copy, retention,
  restore drill) and an operations runbook.
- **Observability.** Structured request logs, OpenTelemetry traces, `/readyz`, a bounded graceful
  shutdown, and database pool sizing.
- **Commercial layer.** `LICENSE.md` (source-available, per-buyer), `THIRD-PARTY.md` with the
  dependency-licence scan behind `bun run licenses`, this changelog, `UPGRADING.md`, `SECURITY.md`,
  `CONTRIBUTING.md` and GitHub issue and pull-request templates.
- **`bun run verify`** — lint, typecheck and test in CI's order, and what the pre-push hook now
  runs, so a push that passes the hook passes CI.
- **`bun run rename`** — renames the kit to your product (name, slug, Tauri identifier, workspace
  scope) across the tracked files, dry-run by default, and prints the residue it cannot safely do:
  Docker volumes, the dev database, `.env`, lockfiles. `LICENSE.md`, `THIRD-PARTY.md`,
  `CHANGELOG.md` and `UPGRADING.md` are left verbatim — they describe the kit, not your product.
- **`bun run seed`** — demo data for a fresh install: `demo@example.com` / `demo-password-1234`
  (`SEED_PASSWORD` overrides), one organization with a team, two workspaces, three documents, six
  finished jobs with their credit-ledger rows, and an audit trail. Idempotent, refuses
  `NODE_ENV=production`, and writes no storage objects.
- **`bun run licenses`** — a dependency-licence audit over the npm and Python trees, with `--strict`
  as a CI gate. `.github/dependabot.yml` keeps the SHA-pinned GitHub Actions current.
- **New environment variables:** `BILLING_DUNNING_DAYS` (14; `0` revokes at period end),
  `AUDIT_LOG_RETENTION_DAYS` (365; `0` keeps entries for ever), `PUBLIC_WEB_URL` (the shell's OAuth
  and Stripe return origin), `PUBLIC_STORAGE_ORIGIN` (the bucket origin the browser's CSP must
  allow), `ACME_EMAIL`, `COMPOSE_PROJECT_NAME`, `BACKUP_DIR`, `BACKUP_CATCHUP`, `BACKUP_MAX_AGE`,
  `BACKUP_COMMAND_TIMEOUT_MINUTES`, `BACKUP_LOCK_TIMEOUT`, and, for `services/ai`,
  `SERVICE_AUTH_DISABLED`, `MAX_TEXT_CHARACTERS`, `MAX_PDF_PAGES`, `EXTRACT_TIMEOUT_SECONDS`,
  `OPENAI_MAX_RETRIES` and `OCR_TESSERACT_BINARY`.
- **`jobs.retry`** (`POST /api/v1/jobs/{id}/retry`) — queue a fresh copy of a job that failed for
  good. `input.retryOf` links it back to the original, and the kind's credits are charged again (the
  original's charge was refunded when it gave up). Audited as `job.retry`. Until now, recovering
  from an outage meant the buyer's support inbox.
- **`admin.organizations.delete`** (`DELETE /api/v1/admin/organizations/{organizationId}`, body
  `confirmSlug`) — the escape hatch for an organization left without an owner. It refuses while a
  subscription is live, deletes the tenant's documents and their stored objects, and is audited
  before the cascade removes the log it wrote to.
- **`billing.status.overLimit`** — the plan limits an organization already exceeds after a
  downgrade; **`jobs.list.includeResult`** (default `false`), so a list no longer carries every
  vector an embedding job produced; and `organizations.auditLog` entries now carry `impersonatedBy`.
- **`bun run --cwd apps/web build:static:desktop`** and the `STATIC_OUT_DIR` build variable: the
  Tauri shell now bundles `apps/web/build-static` instead of `build/`, which the node and Cloudflare
  adapters also write to — a desktop build used to overwrite a server build sitting there, and the
  other way round. `tauri.conf.json`'s `frontendDist` and `beforeBuildCommand` follow.
- **In the app:** Retry on a failed job; a warning on `/app/billing` listing the limits an
  organization is over; per-file upload progress and a Load more button on Documents; confirmation
  dialogs for impersonation and session revocation; the audit log showing who impersonated whom;
  organization deletion behind a typed slug, a seat-mismatch flag and the AI service's `problems`
  under a Degraded label on `/admin/system`; and plan names, blurbs and features as Paraglide
  messages in English and German.
- **CI jobs** for the Tauri crate (`cargo fmt --check`, `clippy`, `check`) and for the Playwright
  end-to-end suite, which until now ran in no workflow at all.

### Changed

- `apps/site` and `apps/docs` now extend the workspace's strict TypeScript base, so
  `noUncheckedIndexedAccess` reaches their source.
- `apps/web`'s test script installs Playwright's Chromium if it is missing, so `bun run test` works
  on a clean machine.
- **`bun run admin:create` no longer accepts `--password`** — breaking for any script that passed
  it. The password comes from `ADMIN_PASSWORD` or an interactive prompt, because an argument is kept
  in shell history and visible in `ps`. It also no longer downloads a CLI at run time, so it works
  inside the API container and cannot drift from the pinned `better-auth`.
- **`bun run db:migrate` exits 1 when a migration is still pending** after the run, instead of
  printing success: Drizzle's migrator silently skips a file whose journal timestamp sorts before
  the newest applied one, which is what merging a branch produces.
- **Paging is uniform and opaque** — breaking for API clients. `jobs.list` and
  `organizations.auditLog` take `cursor` instead of `before`, and `documents.list`, which used to
  return every document in the workspace, gained `limit` (default 50, max 200) and `cursor` and now
  answers `{ items, nextCursor, storage }`. A cursor is an opaque token from `nextCursor`, never a
  timestamp; an unrecognised one is a `BAD_REQUEST` rather than a list that restarts at page one.
- **The version comes from the root `package.json`.** `GET /api/v1/health`, `/admin/system`, the
  OpenAPI `info.version` and the telemetry resource all read it, so no artefact can disagree with
  this file again. `/api/v1/openapi.json` is generated once per process and served with an `ETag`
  and `Cache-Control: no-cache`; a conditional request answers `304`.
- **`documents.complete` verifies the stored object** instead of trusting the client: it rewrites
  `document.size` from what the driver reports, deletes the object and answers `413` when it is
  larger than was declared, `412` when it never arrived, and re-checks the workspace quota against
  the real size.
- **`documents.search` has a budget of its own:** one AI credit per search when the embedding
  provider is not local, 30 searches per minute per user, a 10-second timeout, and a generic `503` —
  the AI service's message quotes provider internals and now reaches only the log.
- **Free-text fields reject control characters** (`BAD_REQUEST` with
  `params.reason = "control_characters"`): document name, workspace name, search query, a flag's
  description and the contact form's name are single-line; the contact message keeps tab, LF and CR.
  A newline in a name used to reach an email subject as a second header. `documents.createUpload`
  no longer declares `UNSUPPORTED_MEDIA_TYPE` at all — a content type outside
  `DOCUMENT_CONTENT_TYPES` was always a `BAD_REQUEST` from the input schema.
- **`/app` and `/admin` answer 503 when the API cannot be reached**, instead of redirecting to
  `/login`. Only an answered 4xx counts as signed out, so an API blip no longer tells a signed-in
  user their session ended.
- **`apps/web` typechecks with `noUncheckedIndexedAccess`**, `.svelte` files included. It still does
  not extend `packages/tsconfig/base.json` — SvelteKit owns the generated base — so the rule is
  repeated in `apps/web/tsconfig.json`. `exactOptionalPropertyTypes` is set nowhere yet.
- **`FormField` moved into `@repo/ui`**, so the form vocabulary is one import.
- **`.env.example` ships `DOMAIN`, `IMAGE_REGISTRY`, `COOKIE_DOMAIN` and `PUBLIC_STORAGE_ORIGIN`
  empty**, and is laid out in three parts (application, self-hosting, backups). A filled-in `DOMAIN`
  had Caddy chase an ACME certificate for a domain the buyer does not own, and `IMAGE_REGISTRY`
  pointed `docker compose pull` at the kit author's namespace; compose now falls back to `localhost`
  and to a local image namespace, so both fail loudly instead of quietly.
- **`COOKIE_DOMAIN` is validated** as a bare hostname that covers both `WEB_URL` and `API_URL`.
- **The production API refuses to boot** without `RESEND_API_KEY`, with an `EMAIL_FROM` on a domain
  no provider accepts, or without `SERVICE_TOKEN` — an empty one switched off the AI service's
  authentication entirely. `SKIP_ENV_VALIDATION` still parses every value, so types are real; only
  the cross-field production rules are skipped.
- **Entitlement is bounded in time.** `active` and `trialing` stop entitling three days past
  `periodEnd`, `past_due` after `BILLING_DUNNING_DAYS`; a daily job (04:47 UTC) reconciles every
  subscription row against Stripe; a downgrade below current usage is refused with
  `PLAN_LIMIT_EXCEEDED_BY_CHANGE`; and Stripe webhook deliveries are deduplicated in a
  `webhook_event` table.
- **Migration `0007_audit_constraints`** adds unique constraints on `member (organization_id,
  user_id)`, `passkey.credential_id` and `subscription.stripe_subscription_id`, plus a foreign key
  on `subscription.reference_id`. On a database that has been in production it fails rather than
  delete rows to make one fit; its header comment carries the query that finds each duplicate.
- **Design tokens** were re-tuned to meet WCAG 2.2 SC 1.4.11 (the focus ring measured 2.59:1), and
  `packages/ui` now has a test that recomputes every ratio from `theme.css` and fails when one
  drifts. `Button`, `Input` and `Select` are thin wrappers over the shadcn components instead of a
  second, differently-sized vocabulary.

### Fixed

- **Deleting a workspace, organization or account no longer orphans stored objects** — the cascade
  returns the storage keys and the bytes go with the rows.
- **An organization can no longer be left with no owner**: deleting the account of a sole owner who
  has co-members is refused, a solo organization is deleted with the account, and either is refused
  while a subscription is live.
- **Expired invitations stop consuming plan seats**, and the daily purge sweeps them.
- **A non-ASCII document name downloads**: `Content-Disposition` follows RFC 6266 on both drivers.
- **A worker only claims job kinds its own build can handle**, so a rolling deploy that adds a kind
  no longer lets old replicas claim and permanently fail those jobs.
- **Plan limits are checked and applied in one transaction** under an organization advisory lock,
  instead of read-then-write.
- **The audit log records the impersonator** (`impersonated_by`) beside the impersonated actor, and
  `organizations.auditLog` returns it as `impersonatedBy`.
- **Both cursors stopped skipping rows.** `created_at` is microsecond `timestamptz` while the cursor
  was a millisecond `toISOString()`, so page two dropped every row inside the truncated millisecond.
  Cursors are now an opaque `(created_at, id)` pair.
- **`workspaces.delete` removes the workspace's stored objects** — best effort, so an unreachable
  bucket is a logged leak rather than an undeletable workspace.
- **The pricing page's plan choice reaches checkout.** `/pricing?plan=…` carries through sign-up and
  email verification to `/app/billing`, which preselects that plan; it used to end in a parameter
  nothing read.

### Security

- **The service worker no longer caches navigations.** It cached authenticated pages — in SSR mode
  with the session response, token included, inlined into the HTML — and cleared them only on a new
  build. It now caches the build manifest and the prerendered public pages and nothing else, and
  signing out clears the caches.
- **Upload and request bodies are bounded at every layer:** Caddy (32 MB on `/uploads/*`, 1 MB
  elsewhere), `Bun.serve`'s `maxRequestBodySize`, a 1 MiB limit on `/rpc/*` and `/api/v1/*`, and a
  streaming byte counter on the presigned `PUT`, which now also requires a `Content-Length` (411).
- **Failed database queries no longer log their SQL and bound parameters**, session tokens included.
- **Security headers everywhere:** every API response carries a `Content-Security-Policy` and
  `Cache-Control: private, no-store`; `apps/web` adds COOP and `no-store` on `/app` and `/admin` and
  derives its CSP at build time from the `PUBLIC_*` values; both Astro sites get a static CSP from
  Caddy; and Caddy's access log deletes `token`, `code`, `state`, `sig` and `email` from the query
  string it records.
- **Better Auth's Scalar reference and generated schema are 404 in production.**
- **`jobs.stream` re-authorizes every 30 seconds** and ends when membership, the role, the session
  or a ban says it should — it was the one endpoint in the product where revoking access did not
  revoke access. A connection lives at most 15 minutes and the client reconnects; one account may
  hold five at a time, and the sixth is refused.
- **The app's `script-src` carries no `'unsafe-inline'`.** The only inline script left is
  SvelteKit's own hydration bootstrap — nonced when server-rendered, hashed when prerendered — which
  cost disabling mode-watcher's head script, so a visitor who forced a theme against their operating
  system sees one frame of the other theme. `apps/web/e2e/csp.e2e.ts` loads four pages in a real
  browser and fails on a console violation or on an `'unsafe-inline'` that creeps back.
- **Email templates escape every interpolated value.** A display name could otherwise carry markup
  into an invitation delivered from the buyer's own DKIM-signed domain.
- **Backups verify what they restore:** the manifest's sha256 is re-hashed before a restore (never
  overridable), a database-name mismatch and connected writers are refused, the restore runs
  `--single-transaction --exit-on-error` under a lock timeout, only one runs at a time, and `list`
  exits 1 on a stale set. The dump is plaintext, which the runbook now says out loud, with what to
  harden around it.
- **Container hardening** (`no-new-privileges`, `cap_drop: ALL`, a process cap) reaches every
  service rather than only `ai`, and every GitHub Action is pinned to a commit SHA.

## [0.3.0] — 2026-09-09

Billing, admin and the frontend platform: the parts that turn a scaffold into a product.

### Added

- **Billing.** Stripe through the Better Auth plugin, with the organization as the customer. A
  browser-safe plan catalogue renders the pricing page and the in-app billing page and drives the
  API's limits. Checkout, customer portal, cancel and restore; per-seat plans that follow the member
  count; trials, dunning emails and a payment-failed banner. Dormant until Stripe keys are set.
- **Admin.** Platform administrators — a role on the user, independent of organization roles — with
  user search, ban and unban, role changes, session revocation and one-hour impersonation; a tenant
  list with members, workspaces and subscription state; feature flags with a global default and
  per-organization overrides; and a system page with version, uptime, counts, database and migration
  state and service health.
- **Component kit.** shadcn-svelte components in `packages/ui` alongside the hand-written
  primitives, with design tokens as `light-dark()` pairs and a Light/Dark/System toggle.
- **Forms and data.** sveltekit-superforms in SPA mode validating the contract's own Zod 4 schemas;
  TanStack Query with keys, fetchers and types derived from the contract.
- **App shell.** Skip link, responsive sidebar, command palette, toasts, dialog confirmations,
  skeletons, empty states, error boundaries with a reference id, and an install prompt.
- **PWA.** A service worker that precaches the build and serves a prerendered offline page,
  registered in production browsers only.
- **Switches.** Sentry error tracking and PostHog analytics, both off until a key is set; PostHog
  loads only after the visitor accepts the consent banner.
- **Accessibility.** axe (WCAG 2.2 AA) over the public pages in the end-to-end suite.

## [0.2.0] — 2026-09-09

Accounts and tenancy, end to end.

### Added

- **Email flows.** Sign-up with verification, password reset, change of email confirmed from the old
  address, and account deletion confirmed by email. Emails print to the API console in development
  and go through Resend when a key is set.
- **Social sign-in.** GitHub and Google, switched on by the presence of their credentials; the
  sign-in page asks the API which providers are live.
- **Two-factor and passkeys.** TOTP with backup codes and WebAuthn passkeys, managed from security
  settings. Sessions can be listed and revoked.
- **Rate limits.** Better Auth's per-IP limits on the auth routes, plus a limiter on every
  procedure.
- **Session guard.** One universal `load` protects the app routes in server rendering and in the
  static SPA, so the same code redirects on every target.
- **Organizations, teams and workspaces.** Owner/admin/member roles, invitations that expire after
  seven days, teams that group members, and workspaces with unique slugs per organization.
- **Access control, plan limits and the audit log.** Roles and permissions defined once and used by
  the auth server, the auth client and the API router; workspace and seat limits enforced
  server-side; an audit log of who did what per organization.

## [0.1.0] — 2026-09-09

The scaffold: one Bun workspace, one HTTP API, every surface a thin client of it.

### Added

- **Workspace and toolchain.** Bun as runtime, package manager and test runner; Turborepo for
  `build`, `check` and `test`; Biome as the only linter and formatter; versions pinned once in the
  root catalog. Internal packages are consumed from source, with no build step.
- **Shared packages.** The oRPC + Zod contract, the typed client, the Better Auth server instance
  and Svelte client, the Drizzle schema with the generated auth tables and the first migration, the
  plan catalogue, the email provider abstraction, the validated environment and the UI package.
- **API.** Hono on Bun with Better Auth at `/api/auth/*`, the oRPC router as `POST /rpc/*` and as
  REST under `/api/v1/*`, and an OpenAPI 3.1 document.
- **Application.** SvelteKit 2 with Svelte 5, building for Node, Cloudflare Workers or a static SPA
  from one `ADAPTER` variable.
- **Public sites.** The Astro marketing site and the Starlight documentation, both static.
- **Native shell.** A Tauri 2 project wrapping the static build with no IPC data layer.
- **Compute service.** An internal FastAPI service managed with `uv`.
- **Infrastructure.** Docker Compose for the whole stack, Caddy for public subdomains or a single
  origin, and a development compose file for Postgres.

<!--
Keep a Changelog's link definitions belong here, resolving the bracketed version headings above to
their releases. They are deliberately absent: this repository has no tags, so every one of those
URLs was a 404 in both editions. The three versions below were written as a narrative of how the
kit was assembled, not cut as releases, and there is no commit that honestly carries v0.1.0 or
v0.2.0. Add the definitions back one line at a time, as each version is actually tagged. Until
then the headings render as plain bracketed text, which is what they are.
-->
