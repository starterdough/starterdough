# Changelog

Every notable change to the kit, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version numbers follow
[semantic versioning](https://semver.org/spec/v2.0.0.html). "Breaking" means breaking for a buyer
merging the release into their fork: a moved file, a renamed export, a changed environment
variable, a migration that must be applied.

The version in the root `package.json` is the single source of truth. The site, the admin system
page and every artefact read it from there. [`UPGRADING.md`](UPGRADING.md) explains how to pull a
release into a renamed fork.

Every release from 1.0.0 on is a git tag, `v1.0.0`, `v1.1.0` and so on, and its date is the day
it was tagged. 0.1.0 to 0.3.0 are the milestones the kit was built in over its first two days,
dated by their commits (0.3.0 by the commit that set the version), and were never tagged.
`package.json` said 0.3.0 from 2026-09-10 until 1.0.0, so a checkout or a publish labelled 0.3.0
can hold anything listed under 1.0.0.

## [1.0.0] - 2026-10-08

The first tagged release, and the first one to upgrade from. Everything after 0.3.0 is here.
Start with Breaking: each entry there asks something of you when you merge, and
[`UPGRADING.md`](UPGRADING.md) gives the steps under "Release by release".

### Breaking

- **Upgrades follow release tags, through a renamed snapshot branch.** `UPGRADING.md` starts you
  on the newest release, files the kit's tags as `kit/v*` so they never collide with your own
  `v*` release tags, and renames each release on a `kit-renamed` branch before `main` merges it.
  A renamed fork now conflicts only where you and the release changed the same lines; the
  previous page's flow conflicted on every changed line holding the name, slug, scope or
  identifier, and its second upgrade stopped on the existing branch. A clone made before 1.0.0
  sets up the `kit/` tags once, as the page shows; if you renamed it with the previous page's
  flow, also delete that `kit-renamed` branch and adopt your fork with `git merge -s ours`.
  `bun run test` runs `scripts/upgrading.test.ts`, which follows the page's commands against a
  miniature kit.
- **This edition's releases are tagged.** Every publish from 1.0.0 on is a `v*` tag, which is what
  lets `UPGRADING.md` start you on a release and merge the next one. The publishes before it were
  never tagged.
- **The Deploy workflow is opt-in.** It builds and deploys nothing until the repository variable
  `DEPLOY_ENABLED` is `true`, so a new repository's first push no longer builds images or fails.
  If you already deploy from Actions, set `DEPLOY_ENABLED=true` when you merge this release, or
  deploys stop (each run says so in a notice). Once it is on, it deploys `main` after CI passes
  ("Deploys wait for CI" under Changed); a pushed `v*` tag still builds images but no longer
  deploys.
- **A server deployed before this release needs `python3` and `flock`** before its first deploy
  of it: deployment recovery (under Added) runs on them. `provision.sh` installs both on a new one.
- **The production API refuses to boot** without `RESEND_API_KEY` or with an `EMAIL_FROM` on a
  domain no provider accepts. Set both in production's environment before you deploy this
  release. `SKIP_ENV_VALIDATION` still parses every value; only the cross-field production rules
  are skipped.
- **SvelteKit 3.** The web app runs on SvelteKit 3.0.1 (GA 2026-10-01), with adapter-node 6,
  adapter-static 4, adapter-cloudflare 8, Svelte 5.57.2 and sveltekit-superforms 3. If Node.js is
  installed it must be 22.17 or newer, because `bun run dev` and `bun run build` start Vite with
  it; `bun run doctor` fails on an older one. [`UPGRADING.md`](UPGRADING.md) lists the changes
  your own code needs.
- **`$lib` is now `#lib`.** It is a subpath import declared in `apps/web/package.json`, and every
  import names its file (`#lib/api.js`).
- **Environment variables are declared in `apps/web/src/env.ts`** and imported by name from
  `$app/env/public` or `$app/env/private`. `$env/*` and `$app/environment` are gone from the app
  (`browser` and `dev` come from `$app/env`). Values are still read when the server starts, so one
  Docker image still serves any deployment.
- **`ORIGIN` is no longer set for the web container.** adapter-node 6 dropped it and takes the
  origin from the `Host` header over https, which Caddy passes through.
- **The service worker moved to `apps/web/src/service-worker/index.ts`.** It is its own TypeScript
  project (checked by `bun run check`), reads `$app/manifest` instead of the removed
  `$service-worker`, and is registered as an ES module because SvelteKit 3 builds it as one.
  Firefox before 147 cannot register it, so there the app runs without the offline page.
- **`handleError` sees every error.** SvelteKit 3 also calls it for `error(...)` thrown on
  purpose. The kit's hooks pass those through unreported, so error pages and Sentry reports are
  unchanged.
- **Navigation.** `refreshAll` replaces `invalidateAll`, `goto(..., { replace, reset: false,
  refreshAll })` replaces the old options, and a shallow `goto` replaces `replaceState`. Shallow
  navigations (the auth pages use them to drop a credential from the address bar) no longer count
  as page views. Of the old forms only `goto`'s `noScroll` and `keepFocus` are gone; the rest
  still work, deprecated.
- **`FormField` moved into `@repo/ui`**, so the form vocabulary is one import. Import it from
  there instead of `$lib/components/FormField.svelte`.
- **`/` redirects to `/app`** (307), where the session guard picks the next page. The landing page
  it replaces and its `common_open_app` and `public_landing_description` messages are gone.
- **`noUncheckedIndexedAccess` reaches every app.** `apps/site` and `apps/docs` extend the
  workspace's strict TypeScript base, and `apps/web` repeats the rule in its own `tsconfig.json`,
  `.svelte` files included, because SvelteKit owns its generated base. Your own code there that
  reads an array element or a record entry may need a check before `bun run verify` passes.
  `exactOptionalPropertyTypes` is set nowhere yet.
- **`bun run admin:create` no longer accepts `--password`.** The password comes from
  `ADMIN_PASSWORD` or an interactive prompt, because an argument stays in shell history and is
  visible in `ps`. It no longer downloads a CLI at run time, so it works inside the API container
  and cannot drift from the pinned `better-auth`.
- **Every `/rpc` call needs the `x-csrf-token` header.** The API answers a call without
  `x-csrf-token: orpc` with `403` and the code `CSRF_TOKEN_MISMATCH`. `@repo/api-client` sends it,
  so the web app, server-side rendering and the shells need nothing. A client of your own that
  calls `/rpc` without `createApiClient` must send it, and the API's CORS `allowHeaders` must keep
  `X-CSRF-Token`.
- **A REST write that carries a cookie must come from a trusted page.** `POST`, `PUT`, `PATCH` and
  `DELETE` under `/api/v1` answer `403 { "error": "forbidden_origin" }` when they carry a cookie and
  their `Origin` is neither `WEB_URL` nor in `TRUSTED_ORIGINS`, or when they have no `Origin` and
  `Sec-Fetch-Site` says `cross-site` or `same-site`. Requests without a cookie (bearer and service
  tokens) and server-side callers that send no `Origin` are not affected.
- **`bun run db:push` is gone**, and so is `@repo/db`'s `push` script. It applied the Drizzle
  schema without any SQL a migration carries beyond it, such as triggers. Change the schema with
  `bun run db:generate`, then `bun run db:migrate`, in development too.

### Added

- **`bun run setup`** creates every local `.env` from the `.env.example` next to it (the root,
  `apps/web`, `apps/site` and `apps/docs`), generates `BETTER_AUTH_SECRET` and sets the local
  `SITE_URL` of the site and the docs. It fills only rows that are missing or blank, so it never
  replaces a value you set and running it twice changes nothing, and it prints no secret.
- **Setup doctor.** `bun run doctor` checks local prerequisites and app configuration, including
  separate Docker CLI, Compose and daemon checks. `-- --database=external` selects an existing
  database; `-- --build` also checks site/docs configuration. It never migrates or connects to
  the database. It names `bun run setup` as the fix for every gap setup can close: a missing
  file, `BETTER_AUTH_SECRET` or `SITE_URL`.
- **Worked feature example.** The guide follows the shared feature-flags screen through its
  database, contract, access rules, translated form and regression checks.
- **A home page.** `/app` shows a getting-started checklist read from the account in place of the
  empty Home heading: verify the address (the link is resent from the list), add a passkey or
  two-factor authentication. The list hides once every step is done. In development builds a
  Build on it card points at the page's file, the worked feature example and the serve-anywhere
  guide.
- **Operations.** Docker Compose for the whole stack with Caddy in subdomain or single-origin
  mode, a provisioning script for a fresh VPS, GHCR image builds and a deploy workflow,
  SOPS-encrypted secrets, a nightly backup tool (`pg_dump`, off-box copy, retention, restore
  drill) and an operations runbook.
- **Observability.** Structured request logs, OpenTelemetry traces, `/readyz`, a bounded graceful
  shutdown, and database pool sizing.
- **Licence and project files.** `LICENSE.md` (source-available, free of charge), `THIRD-PARTY.md`
  with the dependency-licence scan behind `bun run licenses`, this changelog, `UPGRADING.md`,
  `SECURITY.md`, `CONTRIBUTING.md` and GitHub issue and pull-request templates.
- **`bun run verify`**: lint, typecheck and test in CI's order. The pre-push hook runs it.
- **`bun run rename`**: renames the kit to your product (name, slug, Tauri identifier, workspace
  scope) across the tracked files. Dry run by default. Prints the residue it does not touch:
  Docker volumes, the dev database, `.env`, lockfiles. `LICENSE.md`, `THIRD-PARTY.md`,
  `CHANGELOG.md` and `UPGRADING.md` are left as they are.
- **`bun run licenses`**: a dependency-licence audit, with `--strict` as a CI gate.
- **New environment variables:** `PUBLIC_WEB_URL` (where a desktop/mobile shell's emailed links
  point), `PUBLIC_STORAGE_ORIGIN` (an object-storage origin added to the app's CSP),
  `ACME_EMAIL`, `COMPOSE_PROJECT_NAME`, `BACKUP_DIR`, `BACKUP_CATCHUP`, `BACKUP_MAX_AGE`,
  `BACKUP_COMMAND_TIMEOUT_MINUTES` and `BACKUP_LOCK_TIMEOUT`.
- **`bun run --cwd apps/web build:static:desktop`** and the `STATIC_OUT_DIR` build variable. The
  Tauri shell bundles `apps/web/build-static` instead of `build/`, which the node and Cloudflare
  adapters also write to. `tauri.conf.json`'s `frontendDist` and `beforeBuildCommand` follow.
- **In the app:** confirmation dialogs for impersonation and session revocation.
- **CI jobs** for the Tauri crate (`cargo fmt --check`, `clippy`, `check`) and for the Playwright
  end-to-end suite.
- **Public demo mode.** `PUBLIC_DEMO_MODE` (off by default) adds a demo banner and a `noindex`
  tag. A demo may boot without an email provider if it also sets
  `REQUIRE_EMAIL_VERIFICATION=false`. `infra/demo` runs one next to production on the same host.
- **Deployment recovery.** A deploy records the containers it is about to replace before it stops
  any of them. After an interrupted rollout, **Actions → Recover deployment** (or
  `bash infra/scripts/recover-deployment.sh status`, then `recover`, on the server) restarts the
  recorded containers or finishes the new release, whichever is still safe. Deploys, demo updates
  and demo resets share one host lock. It runs on `python3` and `flock`, which an existing server
  needs before its first deploy of this release (see Breaking).
- **`AGENTS.md`** gives a coding agent this repository's layout, its commands and the rules the
  code relies on: contract first, every string a Paraglide message in English and German,
  generated files left to their generators, append-only migrations, environment through
  `@repo/env`, tests next to the code. `CLAUDE.md` imports it, so Claude Code reads the same file.
- **A database test of your own runs in CI without editing the workflow.** Name it `*.db.test.ts`
  and skip it unless `DATABASE_URL` is set and `RUN_DB_TESTS=1`: CI's database job runs every
  tracked file that reads `RUN_DB_TESTS`, each with its own `bun test`, against the migrated
  database. A name with a space or a non-ASCII letter runs like any other, and a file the job cannot
  read fails it. `CONTRIBUTING.md` has the convention and a skeleton.
- **A message in one language only fails `bun run test`.** `apps/web/src/lib/i18n-parity.spec.ts`
  compares the catalogues of every locale in `project.inlang/settings.json`, file by file and key by
  key, and names each catalogue file or key a locale lacks. Paraglide compiles such a key without
  complaint, and so does `bun run check`: a German page showed the English text, an English page the
  key's own name. A key that no catalogue has still fails `bun run check`.
- **`bun run test` gives the deploy-script tests 30 seconds each.** They start real shell scripts,
  and on a busy machine (or one whose malware scanner checks each new process) one could pass the
  5-second default and fail the pre-push `bun run verify` for no reason.

### Changed

- `apps/web`'s test script installs Playwright's Chromium if it is missing, so `bun run test` works
  on a clean machine.
- **`bun run db:migrate` exits 1 when a migration is still pending** after the run. Drizzle's
  migrator skips a file whose journal timestamp sorts before the newest applied one, which merging
  a branch can produce.
- **The version comes from the root `package.json`.** `GET /api/v1/health`, `/admin/system`, the
  OpenAPI `info.version` and the telemetry resource all read it. `/api/v1/openapi.json` is
  generated once per process and served with an `ETag` and `Cache-Control: no-cache`; a
  conditional request answers `304`.
- **Free-text fields reject control characters** (`BAD_REQUEST` with
  `params.reason = "control_characters"`). A flag's description and the contact form's name are
  single-line; the contact message keeps tab, LF and CR.
- **`/app` and `/admin` answer 503 when the API cannot be reached**, instead of redirecting to
  `/login`. Only an answered 4xx counts as signed out.
- **`.env.example` ships `DOMAIN`, `IMAGE_REGISTRY` and `COOKIE_DOMAIN` empty**, and is laid out
  in three parts (application, self-hosting, backups). Compose falls back to `localhost` and to a
  local image namespace, so a missing value fails loudly.
- **`COOKIE_DOMAIN` is validated** as a bare hostname that covers both `WEB_URL` and `API_URL`.
- **Design tokens** meet WCAG 2.2 SC 1.4.11, and `packages/ui` has a test that recomputes every
  ratio from `theme.css` and fails when one drifts. `Button`, `Input` and `Select` are thin
  wrappers over the shadcn components.
- **The sign-in, sign-up and other auth forms render inside a card.**
- **Pages under `/app` fetch their data in `load`**, so the server sends the page rather than
  skeletons. `PageSession` gains `name`, `image` and `twoFactorEnabled`.
- **Content that appears after an action animates in**, and `theme.css` stops every animation and
  transition for visitors who ask their system for reduced motion. Busy indicators keep turning,
  slowly.
- **`bun run db:up` and `db:down` read the root `.env` and always use the `starterdough-dev`
  Compose project**, so `POSTGRES_PORT` applies and a production `COMPOSE_PROJECT_NAME` cannot
  capture the development database.
- **A deploy runs the release's own deployment script.** The workflow checks the release out on
  the server before it runs `infra/scripts/deploy.sh` (and the demo's `update.sh`), so the steps a
  release adds already apply on the deploy that introduces them.
- **`QUICKSTART.md` is the one setup guide.** README, `CONTRIBUTING.md` and the docs site's
  quickstart point to it instead of keeping copies that disagreed.
- **The site and the docs ship a local `SITE_URL`.** Their `.env.example` files hold
  `http://localhost:4321` and `http://localhost:4322`, so a local `bun run build` works, and
  `deploy:cloudflare` refuses a localhost `SITE_URL`. Any other upload of `dist/` needs the
  public origin set by hand first.
- **Deploys wait for CI.** Deploy runs when the CI workflow completes on `main` (`workflow_run`) and
  releases only a passing run of a push whose commit is still `main`'s tip, so a commit with red
  CI is never built or migrated into production, and re-running an old run never releases an older
  commit over a newer one. A run by hand deploys only a commit with a passing CI push run on
  `main`. `v*` tags still build version-tagged images but no longer deploy.
- **`rateLimit()` takes two optional hooks:** `refuse(c, retryAfter)` for a custom over-limit
  response, and `refund(c)`, which hands the request's unit back when it answers true once the
  rest of the chain has run, for a request a later check turned away. The default answer is still
  `429 rate_limited`.
- **`apps/native/README.md` states plainly what a shell build does and does not do today:**
  two-factor sign-in, social sign-in, passkeys, impersonation, keychain token storage,
  auto-update, Windows signing, app stores, mobile and tray, each with what a fix takes.
- **This edition stops describing what it does not ship.** Compose, Caddy (no `/uploads/*` route,
  a 1 MB body limit everywhere), CI, the desktop workflow, `SECURITY.md`, `THIRD-PARTY.md` and
  code comments no longer mention a job worker, uploads, documents or an AI service, and compose
  no longer asks for `SERVICE_TOKEN`.
- **No Dependabot.** This edition ships no `.github/dependabot.yml`: the SHA pins on its GitHub
  Actions move with each release of the kit. A fork that wants them bumped sooner can add one for
  the `github-actions` ecosystem.
- **A feature's contract can live in a file of its own.** The builders (`publicProcedure`,
  `protectedProcedure`, `adminProcedure`) and the text rules (`isSingleLine`, `isPlainText`,
  `controlCharacterRule`) are exported from `packages/api-contract/src/procedures.ts`, so a
  feature's procedures can sit in `src/<feature>.ts`, spread into `contract`, instead of in
  `index.ts`, which every release changes.
  What `@repo/api-contract` exports is unchanged, and so is the OpenAPI document.
- **Working without Docker is named wherever Docker is.** QUICKSTART's prerequisites, the docs
  quickstart, `bun run setup`'s next steps and each failed Docker check in `bun run doctor` point to
  your own Postgres 17 and `bun run doctor -- --database=external`.
- **`bun run db:migrate` names the database it could not reach**: host, port and database from
  `DATABASE_URL`, never the user or the password, and says to start Postgres with `bun run db:up` or
  to check `DATABASE_URL`. A refused login prints its SQLSTATE in place of the server's message,
  which names the user. If a `/`, `?`, `#`, `\` or `@` left unencoded in the user name or password
  makes the URL ambiguous, it names nothing and says to percent-encode them.
- **`bun run rename` ends with the steps UPGRADING.md gives**: `bun install`, `bun run lint:fix`,
  then `bun run verify`.
- **QUICKSTART's prompt for your coding agent starts with "Read AGENTS.md first."** Its first task
  checks whether Step 1 already renamed the kit (a `kit-renamed` branch, or your product name as
  `productName` in `apps/native/src-tauri/tauri.conf.json`). If so it does not run `bun run rename`
  again; otherwise it renames on the `kit-renamed` branch as UPGRADING.md shows, after agreeing the
  slug, identifier and scope with you. Then it works through the residue checklist at the end of
  `scripts/rename.ts`. Troubleshooting explains why `bun run dev:app` stops after a save that
  briefly breaks an import: the API exits on purpose, and turbo stops the web app with it.
- **`bun run auth:schema` fails until the hand-added passkey constraint is back.** The Better Auth
  CLI generates `passkey.credential_id` as a plain index, so every regeneration of
  `packages/db/src/schema/auth.ts` lost the unique index the app relies on, and a `db:generate`
  run after it would have dropped that index from the database. The command now checks the file
  once the CLI has written it and exits 1, naming what is missing and the code that restores it,
  so a chained `db:generate` does not run. `bun packages/db/src/schema/auth-constraints.ts` checks
  again without regenerating, and `bun run test` runs the same check on the committed file. If you
  removed a plugin, it names that plugin's table as missing and says to delete its entries from
  `HAND_ADDED_AUTH_CONSTRAINTS`. The authentication guide, the command reference, QUICKSTART,
  AGENTS.md and CONTRIBUTING.md give the new steps and no longer chain the commands.

### Fixed

- **Flags on narrow screens.** Row actions stack below flag details so longer keys remain readable
  on mobile.
- **Free-edition flag copy.** List and deletion messages describe global flags without referring
  to the paid organization overrides.
- **Per-site local build origins.** A blank inherited `SITE_URL` no longer hides the canonical
  setting in each Astro app's environment file. Nonempty explicit overrides still win and
  missing/placeholder canonical URLs still fail the build.
- **Flag creation validation.** The admin form uses the API contract's schema through the shared
  localized form adapter. No migration or new required environment variable is needed.
- **Verification:** backup integration checks now use the configured database name.
- **The locale switcher waits for hydration before accepting input**, so an early click cannot be
  lost while the browser is still loading the Svelte application.
- **First-admin quickstarts** promote the account created during signup with `--yes`, preserve
  its password, and use a command that works in Bash and PowerShell.
- **Free-edition locale configuration** survives publication. The compiler and Vite now share a
  source config outside the SDK-managed Inlang project directory, so a fresh checkout detects
  browser language instead of silently compiling Paraglide defaults. A publisher regression covers
  this boundary.
- **Desktop release actions** are pinned to commit SHAs, including installer signing and artifact
  publication steps; the Rust toolchain is selected explicitly.
- **A missing page on the static sites answers 404**, still with the site's own 404 page, instead
  of a success, in both Caddy modes and on the demo.
- **Native shells: no dead-end sign-in.** Inside a Tauri shell the sign-in page offers email and
  password only. GitHub/Google sign-in finished in the system browser and passkeys are bound to the
  web app's hostname, so neither could sign the shell in. Accounts created with a provider are told
  to set a password with "Forgot password?". Security settings still list, rename and remove
  passkeys but send adding one to the web app. The same static build served from a static host
  keeps every method (`SOCIAL_SIGN_IN_AVAILABLE`, `PASSKEYS_AVAILABLE` in
  `apps/web/src/lib/api.ts`).
- **Native shells: two-factor accounts.** The pending two-factor cookie never reaches a cross-site
  shell. The code page now says the app cannot finish that step, instead of failing with "invalid
  two factor cookie", and security settings warn before two-factor is turned on in a shell
  (`TWO_FACTOR_SIGN_IN_AVAILABLE`).
- **Native shells: admin impersonation.** Hidden in a shell (`IMPERSONATION_AVAILABLE`). Better
  Auth parks the admin's own session in an `admin_session` cookie a shell never gets back, so "Stop
  impersonating" could not work there. A stop that fails in a shell now signs that session out.
- **Native shells: emailed links.** Resending verification, changing email and deleting the account
  built their links from `location.origin` (`tauri://localhost` or `http://tauri.localhost` in a
  shell). They now use `returnUrl()`, which answers with `PUBLIC_WEB_URL` there. A test fails if a
  page builds an outgoing URL from its own address again.
- **A stale `?next=` no longer strands sign-in.** SvelteKit 3's `goto` rejects a path that no page
  matches. Sign-in, sign-up, two-factor and email verification now fall back to `/app`
  (`routable()` in `#lib/utils/redirect.js`).
- **`/offline` is served as HTML on the Node build.** adapter-node 6 sends prerendered pages
  without a Content-Type, and `apps/web/node-adapter.ts` supplies `text/html` until SvelteKit
  lists it itself.
- **Private repositories deploy with no credentials on the server.** The workflow pushes the
  release commit into the server's checkout over its SSH login, instead of the server running
  `git fetch`, which failed on every private repository. No deploy key or token lives on the box.
  `deploy.sh`'s by-hand rollback skips the fetch for a commit already delivered, and `provision.sh`
  explains a private clone that lacks `GIT_TOKEN` instead of prompting.
- **The QUICKSTART agent prompt checks a fresh setup with `bun run verify`**, instead of a build
  that failed on the default settings.
- **`WEB_URL` and `TRUSTED_ORIGINS` match however they are spelled.** CORS compared a request's
  `Origin` with them exactly as written, so a trailing slash, an upper-case host or an explicit
  `:443` matched no browser, and an app on a different origin from the API failed CORS while
  sign-in, which Better Auth normalises, still worked. Each http(s) entry is now compared as its
  origin, by CORS and by the forged-request check (under Security). Any other scheme with an
  authority (`tauri://localhost`) has only its scheme and authority lower-cased, so a callback such
  as `myapp://auth/Callback` keeps the case of its path, which Better Auth compares. A Better Auth
  pattern (`https://*.example.com`, `https://pr-???.example.com`) and a value with no authority,
  such as an Android app's passkey origin (`android:apk-key-hash:...`), are kept exactly as written.
  CORS and the forged-request check compare exact origins, so a pattern matches no browser there:
  list every origin whose pages call the API.
- **A display name cut at 100 characters never stores half a character.** The cut counted UTF-16
  units, so an emoji at the cut kept half of its surrogate pair, which Postgres turned into U+FFFD.
  It now counts code points. A flag or a skin-tone sequence at the cut can still lose its second
  code point.
- **`.env.example` says the API reads `DATABASE_URL` in development** (`bun run dev`, `dev:app`),
  not only the tooling you run on the host.
- **The docs no longer count the architecture decisions as D1 to D30.** README and the architecture
  reference point at `docs/DECISIONS.md` without a range, and the docs quickstart sends you to
  QUICKSTART's Step 1, item 2 for the rename, not "step 2". QUICKSTART's links to its Step 0 and
  Step 4 headings, which went nowhere on GitHub, now arrive.
- **`isUniqueViolation` recognises a unique violation.** It looked for the SQLSTATE `23505` in the
  driver error's `code`, where node-postgres puts it. Bun's client puts it in `errno`, so the
  check never matched. It now reads `errno`, and moved from `apps/api/src/rpc/base.ts` to
  `@repo/db`, where a test checks it against errors Postgres really raised.
- **`jsonb` columns of your own can hold JSON objects.** drizzle-orm's `jsonb()` and `json()` hand
  Bun's client `JSON.stringify(value)`, and the client encodes that text as JSON again, so an
  object is stored as a jsonb string: it reads back as an object, but `->>` in SQL finds nothing.
  The kit declares no such column, but yours may. `packages/db/src/schema/jsonb.ts` is a `jsonb`
  that has Postgres parse the text once. It writes U+FFFD for `\u0000` and half a surrogate pair,
  which jsonb refuses, and reads a stored string back as that string.
  [`UPGRADING.md`](UPGRADING.md) shows how to move a column onto it and convert its rows in the
  same deploy.
- **QUICKSTART's overview no longer promises that your agent adjusts plans and limits**, which
  this edition does not have.

### Security

- **The service worker no longer caches navigations.** It caches the build manifest and the
  prerendered public pages and nothing else, and signing out clears the caches.
- **Request bodies are bounded at every layer:** Caddy (1 MB), `Bun.serve`'s `maxRequestBodySize`,
  and a 1 MiB limit on `/rpc/*` and `/api/v1/*`.
- **Failed database queries no longer log their SQL and bound parameters**, session tokens
  included.
- **Security headers everywhere:** every API response carries a `Content-Security-Policy` and
  `Cache-Control: private, no-store`; `apps/web` adds COOP and `no-store` on `/app` and `/admin` and
  derives its CSP at build time from the `PUBLIC_*` values; both Astro sites get a static CSP from
  Caddy; Caddy's access log deletes `token`, `code`, `state`, `sig` and `email` from the query
  string it records.
- **Better Auth's Scalar reference and generated schema are 404 in production.**
- **The app's `script-src` carries no `'unsafe-inline'`.** The only inline script is SvelteKit's
  hydration bootstrap, nonced when server-rendered and hashed when prerendered. mode-watcher's head
  script is disabled, so a visitor who forced a theme against their operating system sees one
  frame of the other theme. `apps/web/e2e/csp.e2e.ts` loads four pages in a real browser and fails
  on a console violation or on an `'unsafe-inline'` that creeps back.
- **Email templates escape every interpolated value.**
- **Backups verify what they restore.** The manifest's sha256 is re-hashed before a restore (never
  overridable), a database-name mismatch and connected writers are refused, the restore runs
  `--single-transaction --exit-on-error` under a lock timeout, only one runs at a time, and `list`
  exits 1 on a stale set. The dump is plaintext; the runbook says what to harden around it.
- **Container hardening** (`no-new-privileges`, `cap_drop: ALL`, a process cap) reaches every
  service, and every GitHub Action is pinned to a commit SHA.
- **Forged requests are refused on both procedure transports.** The session cookie is
  `SameSite=Lax`, which keeps it off a write from another site but not from a page on a sibling
  subdomain, and oRPC accepts form-encoded and multipart bodies, so a plain HTML form there could
  call a procedure. `/rpc/*` now requires a header a form cannot send, and `/api/v1/*` refuses a
  cookie-carrying write from an origin outside `WEB_URL` and `TRUSTED_ORIGINS` (both under
  Breaking). `docs/DECISIONS.md` (D32) has the reasoning.

## [0.3.0] - 2026-09-10

Admin and the frontend platform.

### Added

- **Admin.** Platform administrators (a role on the user) with user search, ban and unban, role
  changes, session revocation and one-hour impersonation; feature flags with a global default;
  and a system page with version, uptime, counts, database and migration state.
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

## [0.2.0] - 2026-09-09

Accounts, end to end.

### Added

- **Email flows.** Sign-up with verification, password reset, change of email confirmed from the
  old address, and account deletion confirmed by email. Emails print to the API console in
  development and go through Resend when a key is set.
- **Social sign-in.** GitHub and Google, switched on by the presence of their credentials; the
  sign-in page asks the API which providers are live.
- **Two-factor and passkeys.** TOTP with backup codes and WebAuthn passkeys, managed from security
  settings. Sessions can be listed and revoked.
- **Rate limits.** Better Auth's per-IP limits on the auth routes, plus a limiter on every
  procedure.
- **Session guard.** One universal `load` protects the app routes in server rendering and in the
  static SPA, so the same code redirects on every target.

## [0.1.0] - 2026-09-09

The scaffold: one Bun workspace, one HTTP API, every surface a thin client of it.

### Added

- **Workspace and toolchain.** Bun as runtime, package manager and test runner; Turborepo for
  `build`, `check` and `test`; Biome as the only linter and formatter; versions pinned once in the
  root catalog. Internal packages are consumed from source, with no build step.
- **Shared packages.** The oRPC + Zod contract, the typed client, the Better Auth server instance
  and Svelte client, the Drizzle schema with the generated auth tables and the first migration,
  the email provider abstraction, the validated environment and the UI package.
- **API.** Hono on Bun with Better Auth at `/api/auth/*`, the oRPC router as `POST /rpc/*` and as
  REST under `/api/v1/*`, and an OpenAPI 3.1 document.
- **Application.** SvelteKit 2 with Svelte 5, building for Node, Cloudflare Workers or a static SPA
  from one `ADAPTER` variable.
- **Public sites.** The Astro marketing site and the Starlight documentation, both static.
- **Native shell.** A Tauri 2 project wrapping the static build with no IPC data layer.
- **Infrastructure.** Docker Compose for the whole stack, Caddy for public subdomains or a single
  origin, and a development compose file for Postgres.

<!--
Keep a Changelog link definitions for the bracketed version headings go here, one line per tagged
version from 1.0.0 on. Each edition links its own repository, so each line needs the edition
markers. 0.1.0 to 0.3.0 were never tagged and get none.
-->
