# Architecture decisions

Lightweight ADRs. Each entry records the context, the decision, alternatives considered and the
consequences. Amend by adding a new entry that supersedes an old one; don't rewrite history.

Reference stack given at project start: Astro (public), React Router 8 (apps), Postgres (truth),
Cloudflare + one container host, Next.js literacy. Specialists only when selected:
Framer/Webflow, Shopify, Expo, Liveblocks/Yjs/Durable Objects, Rails/.NET/Spring.

---

## D1 · Bun as runtime, package manager and test runner

**Context.** One JavaScript toolchain for the whole repo was a hard requirement. Bun 1.4 (Aug 2026)
shipped the Rust rewrite with 5× lower idle CPU, 13–48% less memory for HTTP servers, `bun run
--parallel`, `Bun.cron`, HTTP/2+3, and workspace catalogs.

**Decision.** Bun everywhere Node would otherwise run: installs (`bun.lock`), scripts, the API
runtime, `bun test` for TS packages. Node is not installed in the Docker images.

**Alternatives.** pnpm + Node 24 (most boring; loses the single-binary story); Deno (weaker
ecosystem fit for SvelteKit/Astro tooling).

**Consequences.** Some tooling still spawns Node (Vite dev uses Bun fine; Playwright and Astro
run on Bun without issue in this scaffold). Bun-only APIs (`Bun.SQL`, `Bun.serve`) are confined to
`apps/api` and `packages/db`, which only ever run on Bun.

## D2 · Turborepo for task orchestration

**Context.** Bun runs scripts across workspaces (`--filter`, `--parallel`) but has no task graph or
cache. Bun became a stable Turborepo package manager in 2.6.

**Decision.** `turbo.json` defines `build/check/test/dev/clean`; internal packages are consumed from
source ("just-in-time packages"), so only apps have real `build` outputs.

**Alternatives.** Nx (heavier, plugin-centric); plain `bun run --filter` (no caching).

**Consequences.** CI runs the full graph in seconds with caching. Config already uses the `global`
key behind `futureFlags.globalConfiguration` so Turborepo 3 is a version bump.

## D3 · SvelteKit + Svelte 5 for the application (not React Router 8)

**Context.** The reference stack said React Router 8 "for serious web applications". You prefer
Svelte. RR8 (Jun 2026) is a deliberately boring release: ESM-only, middleware default, no capability
gap either way. SvelteKit 2.70 is stable; SvelteKit 3 is in RC with no further breaking changes.

**Decision.** SvelteKit with Svelte 5 runes. Configured in the SvelteKit 3 style already (adapter inside
the `sveltekit()` Vite plugin). Three adapters, selected by `ADAPTER`: node, cloudflare, static.

**Alternatives.** React Router 8 in framework mode (largest ecosystem, React-only UI kits); Next.js
(kept as literacy, not chosen; one integrated React surface isn't the goal here); Astro-only with
islands (not an app framework).

**Consequences.** UI ecosystem is smaller than React's (shadcn-svelte, bits-ui, superforms cover the
essentials). Mobile via Expo is off the table (see D11). Every route works as SSR *and* as SPA, which
is what makes the Tauri shells free.

## D4 · Astro for public surfaces

**Context.** Marketing, docs and blog want static output, content collections, and SEO, not an app
runtime. Astro 7 is current; Astro was acquired by Cloudflare in Jan 2026, so the Cloudflare path is
first-class.

**Decision.** Two Astro apps: `apps/site` (marketing) and `apps/docs` (Starlight). Static output,
deployed to Cloudflare Workers static assets or served by Caddy when self-hosting.

**Alternatives.** SvelteKit prerendering for the site (one framework, but mixes concerns and loses
Astro's content tooling); Framer/Webflow (only if a designer owns the site; reference stack agrees).

**Consequences.** Two build pipelines for content and app; shared tokens via `packages/ui/theme.css`
keep them visually consistent.

## D5 · One HTTP API (Hono + oRPC on Bun) as the single source of truth

**Context.** "Don't use Tauri IPC; build a client in HTTP anyway; have an SSOT all frontends consume."
Typed clients matter for the TS surfaces; REST/OpenAPI matters for Python, curl and third parties.

**Decision.** `apps/api` is a Hono app on `Bun.serve`. Procedures are declared contract-first in
`packages/api-contract` (oRPC + Zod) and implemented once. Two transports over the same router:
`POST /rpc/*` (oRPC RPC link, rich types, used by `@repo/api-client`) and `/api/v1/*` (plain REST +
`openapi.json`). Better Auth is mounted at `/api/auth/*`. oRPC is pinned to the stable 1.x line; v2 is
in beta and renames a few APIs (tracked in the roadmap).

**Alternatives.** tRPC (no native OpenAPI); Hono RPC + `@hono/zod-openapi` (works, shallower type
inference on complex schemas); GraphQL (heavier than needed); SvelteKit server routes as the API
(couples the API to one frontend and to SSR deployments, exactly what "serve anywhere" forbids).

**Consequences.** Every feature is added in two places (contract, implementation) and available in all
clients immediately. The web app has no server-side business logic; SSR is purely a rendering
concern. The API must run on a long-lived Bun process (container/VPS), not on Workers; fine, that is
the "one conventional container host" in the reference stack.

## D6 · Postgres 17 + Drizzle, Bun-native driver

**Context.** "Postgres and SQL: transactional source of truth." Drizzle 0.45 is stable; 1.0 is at
rc.4 with better `bun-sql` support.

**Decision.** Drizzle on the stable line with `drizzle-orm/bun-sql` (Bun's built-in Postgres client,
no npm driver). `casing: 'snake_case'` so TypeScript stays camelCase. Migrations via Drizzle Kit,
committed under `packages/db/drizzle/`. Better Auth tables are generated, never hand-written.

**Alternatives.** Prisma (heavier runtime, generated client); Kysely (query builder only, no schema
generation for Better Auth's Drizzle path); `postgres.js` driver (needed only if the API ever moves to
Workers via Hyperdrive).

**Consequences.** Only Bun can run `packages/db`, intentional, since only the API may touch the DB.
Upgrade to Drizzle 1.0 when stable (roadmap).

## D7 · Better Auth for authentication, sessions and the platform admin

**Context.** Needs: email/password, social sign-in, sessions, two-factor, passkeys, admin
(ban/impersonate), and a transport that works in browsers *and* cookie-less Tauri shells.
Better Auth 1.7 covers all of it as plugins with a Drizzle adapter and a Svelte client.

**Decision.** Plugins: `admin`, `twoFactor`, `passkey`, `bearer` and `openAPI`. Server instance
lives in the API (`@repo/auth/server`); frontends use `@repo/auth/client` (`better-auth/svelte`).
Cookies for the web; bearer tokens (from the `set-auth-token` header) for static/Tauri builds,
switched at build time.

**Alternatives.** Clerk/Auth0/WorkOS (hosted; recurring cost, less control, awkward for
self-hosting); Lucia-style hand-rolled sessions (maximal control, but sessions, two-factor,
passkeys and admin are a lot of code); Supabase Auth (pulls in Supabase as a platform).

**Consequences.** Auth data model is dictated by Better Auth (regenerate on plugin changes). Cross-
subdomain cookies require `COOKIE_DOMAIN`; single-origin deployments avoid the issue entirely.

## D9 · Tauri 2 shells with no IPC, and the "Cargo or Bun?" answer

**Context.** You asked whether to build the local/desktop layer in Cargo (Rust) or Bun, noting Bun's
speed after the Rust rewrite. Tauri 2.11 is stable with first-class Android/iOS; v3 is not on the
horizon.

**Decision.** Tauri, therefore Cargo builds the shell, but the shell is ~20 lines of Rust that opens a
webview on the SvelteKit static build. There are no Tauri commands, no IPC data layer, no `@tauri-apps/api`
in the frontend; the frontend uses the same HTTP client as the browser. Bun runs everything else
(dev server, builds, the API, tooling). Rust is added only as Tauri *plugins* for things the web
platform cannot do (tray, autostart, deep links, updater, notifications, biometrics).

Why the speed argument doesn't decide it: with no IPC there is no hot path in Rust to be fast *or*
slow. What Tauri buys is a ~10 MB binary on the system webview, mobile targets from the same project,
signed installers and an updater. What Bun would buy (an Electrobun-style Bun main process or a
compiled Bun sidecar) is only useful if the desktop app needs local compute or a local server; it
doesn't, by design.

**Alternatives.** Electron (100+ MB, Chromium shipped per app); Electrobun (Bun-native, young, desktop
only); Capacitor for mobile (JS-native, mature; fallback if Tauri mobile ever blocks a store
requirement); PWA only (no store presence, limited OS integration).

**Consequences.** Rust toolchain is a dev prerequisite for `apps/native` only. Auth inside the shell
uses bearer tokens. Two distribution modes per platform: bundled SPA or remote URL thin client.

## D10 · PWA as the baseline for "local on my computer" and "mobile site"

**Context.** Not every user wants an installer, and phones are the most common "mobile site" client.

**Decision.** `apps/web` ships a manifest, theme color and installable icons out of the box; a
service worker for offline is a roadmap item. Tauri is the *escalation* for native needs, not the
default.

**Consequences.** Same URL serves the site, the installable PWA and the shell's remote-URL mode.

## D11 · Mobile app = Tauri mobile (or PWA), not Expo

**Context.** The reference stack lists Expo for mobile. Expo means React Native, i.e. a second UI
codebase in a different framework, at odds with D3 and with a one-person-scale team.

**Decision.** Tauri 2 mobile from the same `apps/native` project (`android:init`, `ios:init`), wrapping
the same Svelte UI. PWA install as the zero-effort path. Capacitor is the fallback if Tauri mobile
proves problematic for a store requirement.

**Consequences.** Mobile UX is web UX with responsive design; invest in it. Truly native mobile UI
(gestures, native navigation) would require revisiting this decision.

## D12 · Hosting: Cloudflare for edge/static, one container host for servers, self-host as first-class

**Context.** "Cloudflare plus one conventional container host" from the reference stack, and the
requirement to self-host on a VPS with anywhere access.

**Decision.** Astro sites (+ optionally SvelteKit SSR) on Cloudflare Workers static assets. The API
and Postgres on a container host *or* your VPS via `infra/compose.yml` with Caddy. Dockerfiles
live next to each app; compose builds from the repo root.

**Alternatives.** Vercel (great for Next.js; not the chosen frontend); running the API on Workers with
Hyperdrive (possible later by swapping the DB driver, deliberately deferred).

**Consequences.** Two cookie topologies are supported: subdomains (public) and single-origin
(tailnet/LAN). Choose via `CADDY_MODE`.

## D13 · Tailscale for private and public access to the self-hosted stack

**Context.** Phone and laptop should reach the home/VPS deployment without opening ports or managing
DNS/TLS by hand.

**Decision.** Tailscale on the host. `tailscale serve` exposes Caddy to the tailnet with a MagicDNS
HTTPS name; `tailscale funnel` makes the same URL public. Single-origin Caddy mode keeps cookies and
CORS trivial.

**Alternatives.** Cloudflare Tunnel (public only, ties to Cloudflare account); WireGuard by hand;
port-forwarding + Let's Encrypt (works, more moving parts).

## D14 · Biome as the only linter/formatter

**Context.** Prettier + ESLint + plugins for Svelte and Astro is four configs. Biome 2.3+ formats and
lints Svelte/Astro/Vue behind `html.experimentalFullSupportEnabled`; 2.4 fixed most false positives.

**Decision.** Biome for everything (TS, JSON, CSS with Tailwind directives, Svelte, Astro). Generated
files (`packages/db/src/schema/auth.ts`) and SVGs are excluded.

**Consequences.** If Svelte formatting misbehaves on an edge case, add Prettier + `prettier-plugin-svelte`
for `*.svelte` only; keep Biome for the rest. Revisit when the flag graduates.

## D16 · Thin-client SvelteKit: SSR is rendering, not a BFF

**Context.** SvelteKit can host server routes and form actions; using them for business logic would
make the web app a second API and break "serve anywhere".

**Decision.** `apps/web` never imports `@repo/db` or `@repo/auth/server`. Server `load` functions call
the API with SvelteKit's `fetch`; `hooks.server.ts` rewrites to the internal API origin and forwards
cookies. Form actions, if used, proxy to API procedures.

**Consequences.** Slightly more HTTP hops during SSR (mitigated by the internal origin), in exchange
for a frontend that is byte-for-byte the same in Node, Workers and Tauri.

## D17 · Package strategy: source-consumed packages, catalog-pinned versions

**Decision.** Internal packages export TypeScript/Svelte source (`exports` → `./src/index.ts`); no
build step, no `dist`. Shared third-party versions are declared once in the root `catalog` and
referenced with `catalog:`. Server-only packages extend `@repo/tsconfig/bun.json`; browser-safe ones
extend `base.json`.

**Consequences.** Fast iteration, no stale builds. Publishing a package externally would require
adding a build (Bun replaces `catalog:`/`workspace:` on `bun publish`).

## D18 · The session guard is a universal `load`, not `+layout.server.ts`

**Context.** Protected routes should redirect *before* rendering, server-side when there is a
server. The obvious SvelteKit answer is `+layout.server.ts`, but the static build (D9, Tauri) has
no server at all: server `load` functions would 404 in the SPA, splitting the codebase per target.

**Decision.** `apps/web/src/routes/(app)/app/+layout.ts` is a *universal* load. It calls
`authFor(fetch).getSession()` and throws `redirect(303, '/login?next=…')` when there is no
session. During SSR it runs on the server (the redirect is a real 303; `hooks.server.ts` forwards
the browser's cookies); in the SPA it runs in the browser with the bearer token. Same file, all
targets. `/login` and `/signup` use the same trick in reverse (signed-in → `/app`).

**Alternatives.** `+layout.server.ts` (breaks the static target); client-only guard in the
component (flashes protected UI, no server redirect); a SvelteKit `handle` hook (server-only again).

**Consequences.** `data.session` is serialised into the page. Each SSR navigation into `/app`
costs two `get-session` calls (the load and the reactive `useSession()` store); cheap, and the
reactive store is what keeps the sidebar current after profile changes.

## D19 · The UI discovers auth capabilities from the API

**Context.** The sign-in page must know which social providers are configured and whether
sign-up ends in "check your inbox". That information lives in the API's env; mirroring it in
`apps/web/.env` (`PUBLIC_AUTH_PROVIDERS=…`) would be a second source of truth that drifts.

**Decision.** A public procedure, `system.authConfig` (`GET /api/v1/auth-config`), returns
`{ socialProviders, requireEmailVerification }` computed in `@repo/auth/server` from the same env
that configures Better Auth. The `(auth)` layout loads it once (with a safe fallback when the API
is down) and every auth page renders from it.

**Consequences.** One extra cached request on auth pages. Adding a provider is one env pair plus
one entry in `SocialProviderSchema`; no frontend redeploy is required to toggle it.

## D22 · Admin: platform role on the user, plugin for people, our procedures for the rest

**Context.** The deployment's operator needs to find and suspend users, act as one of them to
reproduce a bug, switch features on and off, and check that the box is healthy, without a second
app or a second auth system.

**Decision.**
 - **Who.** A platform administrator is a *user* with `role` in `ADMIN_ROLES` (`['admin']`,
   `@repo/auth/permissions` → `isAdmin`), a flag on the account, granted to nobody by default.
   The same list drives Better Auth's `admin({ adminRoles })`, the API's `requireAdmin`
   middleware and the `/admin` route guard (a universal `load`, like D18, redirecting non-admins
   to `/app`).
- **People are the plugin's.** Search, ban/unban (with reason and expiry), set role, revoke
  sessions and impersonation come from the Better Auth admin plugin at `/api/auth/admin/*`; we add
  no procedures for them. Impersonation sessions last one hour and cannot target other admins;
  the app shell shows a banner with "Stop impersonating" whenever `session.impersonatedBy` is set.
 - **Flags and health are ours.** Feature flags live in `feature_flag`, one row per flag with its
   global default; clients read the resolved map from `system.flags`, admins manage the table.
   `admin.system.status` reports version, uptime, counts, a database probe with migration state
   (journal shipped in the build vs. `drizzle.__drizzle_migrations`), and which optional
   subsystems are configured, never secrets.
- **Bootstrap.** `bun run admin:create -- --email … --password …` wraps the Better Auth CLI's
  `create-admin` with the root `.env` (a small spawner, because `--env-file` does not reach a
  `bunx` child). Existing users are promoted from `/admin/users`.

**Alternatives.** A separate admin app (second deploy, second session model); `adminUserIds` from
env (works for one operator, invisible in the UI, no promotion path); storing flags in env or a
config file (redeploy to change one); an external flag service (fine later; `system.flags` is the
seam to swap behind).

**Consequences.** Admin actions on users are not recorded in an audit trail of our own; rely on
Better Auth's request logging or add one when needed. Flag reads are one indexed query per page
load with no caching; add a short cache when flags are read on hot paths. Deleting users is
deliberately not exposed in the UI.

## D23 · Frontend platform: shadcn-svelte in the shared package, SPA forms, TanStack over the contract

**Context.** Phases 1–4 built every screen with five hand-written primitives and ad-hoc `$state`
loading/error handling. A kit needs the rest of a product UI: dialogs, menus, a command palette,
toasts, skeletons, dark mode, forms with real validation, a client cache, plus offline, error
tracking and analytics as switches the deployer can flip. All of it has to work on every target:
SSR (Node, Cloudflare) and the static SPA inside Tauri.

**Decision.**
- **Components: shadcn-svelte (bits-ui) generated into `packages/ui`**, not into the app.
  `packages/ui/components.json` aliases point at the package itself (`@repo/ui/utils.js`,
  `@repo/ui/components/ui/…`), resolved through package `exports` at runtime and `tsconfig`
  `paths` inside the package, so `bunx shadcn-svelte@latest add <name> -c packages/ui` keeps
  working and every surface imports one copy. `Button`, `Input` and `Select` are thin wrappers
  over the shadcn components (one implementation, one 32 px scale, one focus treatment) that
  keep the app's prop names (superseding the original "two vocabularies" split, D30):

  | wrapper prop | shadcn | note |
  |---|---|---|
  | `variant="primary"` / `secondary` / `ghost` | `default` / `secondary` / `ghost` | |
  | `variant="danger"` | `destructive` | tinted, not solid red |
  | `size="sm"` / `md` / `lg` | `sm` (h-7) / `default` (h-8) / `lg` (h-9) | |
  | `Input`/`Select` `invalid` | `aria-invalid` | what the shadcn styling keys off |
  | `Button href` | renders `<a>` | no more buttons nested in anchors |

  `Alert`, `EmptyState`, `Label` and `FormField` have no shadcn counterpart. Icon-only buttons,
  `outline`/`link` variants and file inputs import the shadcn component directly
  (`packages/ui/README.md` is the reference, including the `catalog:` restore step after
  `shadcn-svelte add`). Generated files are ours to edit; every divergence from the registry
  carries a comment naming the reason (`Command.List` renders bits-ui's `Viewport` and is a tab
  stop); a Biome override relaxes two a11y rules for that directory.
- **Theme: shadcn's token set as `light-dark()` pairs.** `theme.css` defines the un-prefixed
  variables once (`--background: light-dark(…, …)`) and maps them in `@theme inline`; the page
  follows the OS through `color-scheme: light dark` with no JavaScript (the Astro sites get dark
  mode for free), while `.light`/`.dark` on `<html>` force a scheme; mode-watcher writes those
  classes and persists the choice. The `dark:` variant matches both the forced class and
  "OS dark unless `.light`", so utilities and tokens agree. Lightning CSS lowers `light-dark()`
  to a variable pair for older engines; the semantics survive. The set deviates from shadcn's
  neutral base where the defaults fail WCAG 2.2 SC 1.4.11 / 1.4.3: `--ring` and `--sidebar-ring`
  (2.6:1 → 4.7:1 light), `--input` (1.3:1 → 3.2:1), `--muted-foreground`, `--destructive`, plus
  `--overlay`, `--success*` and `--warning*` which shadcn does not define. `packages/ui`'s `test`
  script (`scripts/contrast.ts`, dependency-free) recomputes 16 ratios × 2 schemes from
  `theme.css` and fails when any of them drifts; `--tw-ring-offset-color` is set on `*` because
  Tailwind v4 registers it `inherits: false`, so a `:root` value never reaches a control.
- **Forms: `sveltekit-superforms` in SPA mode with Zod 4**, never form actions; the API is the
   backend on every target and the static build has no server. Schemas are shared with the
   contract where one exists (a procedure's `.input()`) and live in `$lib/schemas.ts` otherwise
   (auth, account).
  `spaForm` in `$lib/forms.ts` carries the common options; `applyApiError` maps an oRPC failure
  back onto fields or the form. Submit buttons stay disabled until hydration because a native
  `POST` to a page without actions is a 405.
 - **Data: `@tanstack/svelte-query` v6 (runes) with `@orpc/tanstack-query`**: keys, fetchers and
   types derive from the contract (`orpc.account.me.queryOptions(…)`, `orpc.account.key()`).
   Queries are disabled during SSR (they would run without the session cookie); pages render
   skeletons on the server and fetch on the client, or load in `load` with `apiFor(fetch)` when
   the HTML must contain data (guards). Mutations invalidate exactly what they changed. One
   `QueryClient` per browser session, provided from the root `+layout.ts`.
 - **Flags in the app.** The `(app)` layout load fetches `system.flags` once per session
   (`page.data.flags`, `flag('key')` in components); an unreachable API means "nothing is on".
 - **Shell.** Skip link + one `<main id="main">` per page, sidebar from `md:` and a `Sheet` below,
   command palette (Ctrl/⌘K: navigation, theme, sign out),
  `svelte-sonner` toasts for every successful mutation, `Dialog` confirmations for destructive
  actions (typed confirmations stay inline), `Skeleton`/`EmptyState` for every list, a
  `<svelte:boundary>` around page content, `+error.svelte` at the root and inside the shell, and
  `handleError` hooks that attach a reference id.
- **Deployment switches, all off by default.** Sentry (`PUBLIC_SENTRY_DSN` / `SENTRY_DSN`) is
  imported dynamically only when a DSN is set; the SDK is not in the bundle otherwise; the
  Cloudflare build uses `initCloudflareSentryHandle` per request, Node initialises once in
  `init`. PostHog (`PUBLIC_POSTHOG_KEY`) loads only after the visitor accepts the consent banner;
  page views come from `afterNavigate`. The service worker (`src/service-worker.ts`: precache +
  network-first + prerendered `/offline` fallback) is registered by `$lib/pwa.svelte.ts` in
  production browsers only, never in dev, never in the Tauri shells; the same module captures
  `beforeinstallprompt` for an "Install app" button.
- **Accessibility is tested.** `@axe-core/playwright` (WCAG 2.2 AA) runs in `test:e2e` on the
  public pages plus a skip-link test; the authenticated pages were axe-clean in the verification
  pass in both modes (the dark-mode danger button needed `--destructive-foreground` to flip to
  dark text; white on the lighter dark-mode red is 2.8:1).

**Alternatives.** Growing the hand-written set (weeks of accessible primitives for no gain);
shadcn-svelte inside `apps/web` (the Astro sites and future surfaces would copy components);
`:root`/`.dark` token blocks (the sites would need a class-toggle script to follow the OS);
SvelteKit form actions (no server in the static build, and a second validation path beside the
API); Svelte stores for data (v5 of svelte-query was store-based and unreliable under runes);
`@vite-pwa/sveltekit` (a generator on top of the same `$service-worker` module, not needed for
one worker); statically importing Sentry (≈460 KB minified in every deployment).

**Consequences.** The client ships bits-ui + floating-ui + sonner (≈276 KB minified, shared
chunk) on every page of the app. Components added later must be exported from
`packages/ui/src/index.ts` (namespaced when multi-part). `taintedMessage` is off by default;
enable it per form where unsaved edits matter. Flags are read once per session; `invalidateAll()`
to refresh them. i18n (paraglide) is the one §5 item left; it touches every string and is best
done in one pass.

## D24 · i18n: Paraglide messages, locale from a cookie, no URL prefixes, copy owned by the UI

**Context.** Every string in `apps/web` was English in the templates. The app is served as SSR
(Node, Cloudflare) and as a static SPA inside the Tauri shells, so whatever decides the locale has
to work without a server and without rewriting routes. Validation messages come from Zod schemas,
some of which live in the contract and are also the API's own error text.

**Decision.**
- **Paraglide JS 2** (`@inlang/paraglide-js`, compiler + Vite plugin; the generated runtime has no
  dependency). Messages are plain JSON per locale in `apps/web/messages/{en,de}/*.json`, one file
  per area (`common`, `public`, `auth`, `shell`, `app`, `account`, `admin`) merged into one flat
  namespace by the message-format plugin's `pathPattern` array, so several people (or agents) can
  extract strings in parallel without touching the same file. Keys are `<area>_<page>_<element>`
  snake_case; plurals are variant messages (`countPlural=one|other`), never concatenation. The
  compiler output (`src/lib/paraglide/`, gitignored) is regenerated by the Vite plugin on dev/build
  and by `bun run i18n:compile` before `svelte-check`/`vitest`; options live once in
  `project.inlang/paraglide.config.ts` (read by both). Dev compiles one module per locale (few
  files, fast HMR); builds compile one module per message so each route chunk carries only its
  own text.
- **Locale = `cookie` → `preferredLanguage` → `baseLocale` (`en`).** No `url` strategy: the same
  paths serve every locale, which is what a static SPA and the Tauri shells need, and what keeps
  the universal guards (D18) unchanged. On the server `paraglideMiddleware` (hooks.server.ts) runs
  inside `handle`, keeps the request's locale in AsyncLocalStorage for loads, components and
  `handleError`, and fills `%lang%`/`%dir%` in `app.html` (`nodejs_als` is already on for
  Cloudflare). The static shell is rendered without a request, so the root layout also sets
  `<html lang>` on the client. Switching (`LocaleSwitcher`, in Settings and on the public pages)
  calls `setLocale()`, which writes the cookie and reloads; messages are plain function calls,
  not reactive, so a full render is the honest way to re-evaluate them all. `de` is the second
  locale to prove the pipeline; its text is a machine-drafted first pass, marked as such.
- **Validation copy belongs to the UI, rules to the contract.** Zod 4 lets a schema-level message
  win over every error map, so the contract keeps its developer-facing English (it is also the
  REST API's text) and the web does not strip it: `zodForm(schema)` (`$lib/forms.ts`) validates
  and then phrases each issue from its `code`/`format`/`params` (`issueMessage`), falling back to
  Zod's own message, which `applyZodLocale` (`$lib/i18n.ts`) localises with `zod/locales` on the
  client. Rules that need recognising carry `params` (the reserved-slug refine →
  `{ reason: 'reserved_slug' }`); web-owned schemas (`$lib/schemas.ts`) use lazy messages
  (`{ error: () => m.…() }`) so they resolve at validation time. Dates and numbers go through
  `Intl` with the current locale (`formatDate`, `formatRelative`, `formatNumber`).
 - **Out of scope for now:** the API's emails (need a stored user preference, a Better Auth
   additional field, and templates per locale), the Astro sites (English marketing copy), and
   right-to-left layout (the `dir` attribute is wired; no RTL locale is configured).

**Alternatives.** `svelte-i18n`/`i18next` (runtime dictionaries, no tree-shaking, string keys
without types); URL prefixes `/de/...` (would need the static SPA to route by prefix, duplicate
the guards and break deep links from emails); `localStorage` first (the server cannot read it;
first paint would flash English before hydration); stripping the contract's messages so an error
map applies (would degrade the REST API's own error text for every consumer); reactive
`setLocale(…, { reload: false })` (documented by Paraglide as an escape hatch, not for a picker).

**Consequences.** Every new string is a message: add it to the area's `en` and `de` files and
call `m.key()`; svelte-check fails on a missing key. Module-level `m.…()` constants in `.ts`
files are a bug on the server (evaluated once per process); call inside functions. Keys are
global across files; prefixes keep them unique. `project.inlang/.gitignore` is written by the
inlang SDK and ignores everything but `settings.json`, so `paraglide.config.ts` is force-tracked
(`git add -f`); keep it tracked. The German copy needs a native review before a launch.

## D25 · Public sites: static Astro on the shared tokens, content collections, one public API procedure

**Context.** `apps/site` was a two-page placeholder and `apps/docs` the Starlight starter. The
sites have to stay deployable as plain files (Cloudflare Workers static assets or Caddy in the
compose stack), share the app's look without sharing its JavaScript, and give the API a public
surface for the one thing a marketing site needs from a backend: a contact/waitlist form.

**Decision.**
- **`apps/site` stays `output: 'static'`** with Tailwind 4 and `@repo/ui/theme.css`, the same
  `light-dark()` tokens as the app, so it follows the OS colour scheme with no script and no
   toggle (D23). Its only workspace import is the theme; nothing server-side, as the README rule
   demands. Pages: landing, features, changelog, blog, legal, contact, 404. Copy is grounded in
   README and these ADRs, not invented.
- **Content is data:** `blog`, `changelog` and `legal` are Astro content collections
  (`src/content.config.ts`), so posts, release notes and policy texts are markdown with typed
  frontmatter. The legal pages ship as templates with visible placeholders and a "review with
  counsel" note rather than pretending to be policy.
- **SEO at build time only.** `@astrojs/sitemap`, RSS (`@astrojs/rss`), a generated `robots.txt`
  whose `Sitemap:` line follows `SITE_URL`, canonical/OG/Twitter tags from one `SEO.astro`, and Open
  Graph images rendered during `astro build` by `astro-og-canvas` (one PNG per page, post and legal
  doc). No runtime image service; the deploy target is a static host. `compressHTML` is off:
  Astro's compressor removes the whitespace between text and inline elements that Biome's wrapping
  produces ("on<a>GitHub</a>").
- **Contact / waitlist = one public procedure**, `contact.send` (`POST /api/v1/contact`), in the
  contract like everything else (REST + OpenAPI for free). It is rate-limited hard in `app.ts`
  (5/hour/IP on top of the general limiter), carries a hidden honeypot field (bots get `ok: true`
  and nothing happens), and emails `CONTACT_EMAIL` through `@repo/email` with the sender as
  reply-to and every user-typed value HTML-escaped. Development needs no configuration (the console
  provider prints it); with a real provider and no recipient it answers 412. The form on the site
  is plain HTML plus a small inline script; Turnstile has a marked slot but is not wired.
- **Browser calls from the sites need CORS.** The API's allow-list (`trustedOrigins()`) includes
  `http://localhost:4321/4322` outside production; production adds the real site and docs origins
  to `TRUSTED_ORIGINS`. The docs' API reference is Scalar's web component pointed at
  `${PUBLIC_API_URL}/api/v1/openapi.json`, the live document, not a checked-in copy.
- **`apps/docs`** gets an information architecture (Start / Guides / Reference) sourced from
  README, DECISIONS and the infra notes, `astro check` in `turbo check`, an `editLink` to the
  repository, and the Scalar page under Reference.
- **Build inputs are explicit.** `SITE_URL`, `PUBLIC_APP_URL`, `PUBLIC_DOCS_URL`, `PUBLIC_API_URL`
  are read at build time; `infra/docker/Dockerfile.static` takes them as build args and
  `infra/compose.yml` passes them from `DOMAIN`/`WEB_URL`/`API_URL`.

**Alternatives.** Rendering the sites with SvelteKit (would drag the app's bundle into pages that
need none); a hosted form service or Formspree (a second backend and a data processor for the one
form we have); `starlight-openapi` (static pages from a checked-in spec that drifts from the API;
Scalar reads the live one); OG images at request time (`satori`/`resvg` need a runtime); a
`theme-toggle` on the site (the tokens already follow the OS; the app has the toggle because it
persists a per-user choice).

**Consequences.** Both sites are English-only for now (D24 covers the app). The first `astro
build` of the site fetches the Inter font for the OG images; CI and Docker need network at build
time. Changing any of the four build-time URLs means rebuilding the static image. Deploying to
Cloudflare (`bun run deploy:cloudflare` in each site) still needs the owner's account and domains.

## D26 · Native shell: three run modes, bearer verified on the real origin, CSP from the env, external URLs leave the webview

**Context.** D9 decided the shape of `apps/native` (Tauri 2, no IPC) but the shell had never been
run. Four things depended on the shell's real origin (`http://tauri.localhost` on Windows,
`tauri://localhost` elsewhere) and could only be verified there: the bearer flow (D7) with no cookies
at all, the locale choice surviving a webview that drops cookies, a CSP that names the API instead
of `https:`, and what happens when the app navigates to a third party (a payment page, an OAuth
provider) inside a window that has no address bar and no back button.

**Decision.**
- **Three ways to run the shell, one config.** `dev:desktop` (`tauri dev`) starts `apps/web` as
  `dev:static`: Vite with `ADAPTER=static` on its own port (5175, `strictPort`) so the bearer code
  path runs in development too and the SSR dev server on 5173 can keep running next to it.
  `preview:desktop` is `tauri build --debug --no-bundle` + run: the static build embedded in a debug
  binary and served by Tauri from the real origin: the pre-release check, a minute instead of a
  release build. `build:desktop` produces the installers. The window is declared in `tauri.conf.json`
  with `create: false` and built in `setup` from that config, because navigation handlers exist only
  on the builder.
- **Bearer stays in `localStorage`; the locale gains a `localStorage` copy.** Verified in the
  preview shell: every API request carries `Authorization: Bearer …`, a cookie-only
  `/api/auth/get-session` from the shell answers `null`, the token survives reloads, sign-out clears
  it. The Paraglide strategy becomes `cookie → localStorage → preferredLanguage → baseLocale` for
  *every* build (D24 had `cookie → preferredLanguage → baseLocale`): `setLocale()` writes both, the
  server still reads only the cookie, and a webview that loses its cookies between launches still
  finds the choice. One chain for all targets keeps a single compiled runtime; `dev` and
  `dev:static` share `src/lib/paraglide`, and two strategies would fight over it.
- **CSP is generated from the same inputs as the SPA.** `scripts/tauri-config.ts` reads
  `apps/web/.env` (+ process env) and writes `apps/native/tauri.build.conf.json`, merged over
  `tauri.conf.json` with `--config`: `connect-src 'self' <PUBLIC_API_URL>` plus the Sentry / PostHog
  origins when their keys are set. The base policy keeps `https:` so a plain `tauri build` still
  works; `devCsp` is permissive for Vite. Tauri adds the SHA-256 of SvelteKit's inline bootstrap
  scripts itself. The API's dev allow-list gains the shell origins and `localhost:5175` so a fresh
  clone works without editing `TRUSTED_ORIGINS`.
- **External URLs open in the system browser; the webview never leaves the app.** ~30 lines of Rust:
  `on_navigation` allows the app origins (`tauri://`, `tauri.localhost`, the dev URL in debug builds)
  and hands any other `http(s)`/`mailto` URL to `tauri_plugin_opener::open_url`, the *Rust* function
  only; the plugin is not registered, so no `plugin:opener` commands exist for the frontend and the
  shell stays IPC-free. `on_new_window` (`window.open`, `target="_blank"`) does the same and denies
  the popup. Other schemes are dropped with a log line; a shell is not a launcher.
- **Releases** are a GitHub Actions matrix (`.github/workflows/desktop.yml`, `tauri-apps/tauri-action@v1`)
  on `v*` tags: Windows NSIS+MSI, macOS arm64 + x64, Linux AppImage/deb/rpm, uploaded to a draft
  release; `PUBLIC_API_URL` is a repository variable so the SPA and its CSP agree. The bundle
  identifier is `dev.starterdough.native`; Tauri rejects identifiers ending in `.app` on macOS.
- **Verification method worth keeping:** WebView2 honours `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
  --remote-debugging-port=9333`, and Playwright's `connectOverCDP` then drives the shell's page like
  any Chromium tab. Sign-up, org + workspace, reload, locale, sign-out and sign-in were run this way
  in the dev shell, the preview shell (twice) and the release binary.

**Alternatives.** Running `dev:desktop` against the SSR dev server on 5173 (what the scaffold did:
cookies work there because both are `localhost`, so nothing shell-specific was exercised and a
second Vite would have taken the port); a Tauri-only paraglide strategy (`localStorage` first for
`ADAPTER=static` only, two compiled runtimes in one checkout); `@tauri-apps/plugin-opener` from the
frontend (an IPC surface, a capability to maintain, and every external link would need to know it
runs in a shell); keeping `https:` in `connect-src` (simpler, but then the CSP says nothing);
Stronghold / an OS-keychain plugin for the token now (a real improvement, but it makes the token
store async and adds a Rust dependency with a password story; deferred, roadmap §7).

**Consequences.** Social sign-in started from the shell opens in the system browser and finishes
there, on the web app; the shell does not learn about the result until the user comes back and
the page refetches (`get-session`). Closing that loop is the deep-link work
(`tauri-plugin-deep-link` + a Better Auth hook that puts the session token on the callback) that
remains open in §7. `tauri dev` restarts on any change under
`src-tauri/`, hence the generated config lives one level up. The first Cargo build needs the
platform prerequisites (MSVC build tools, WebView2, webkit2gtk…) and minutes; mobile init needs
Android Studio / Xcode, neither of which was on the machine.

## D28 · Operations: compose is the deliverable, the owner's VPS is a runbook

**Context.** Phases 1–8 built the product. Phase 9 is "serve it": a VPS, Tailscale, Caddy modes,
backups, traces, health, CI deploy, secrets, audits, a load test. The kit cannot provision the
owner's accounts (a VPS, a Tailscale tailnet, a domain, an S3 bucket). What it can ship is a
compose file that is safe to `up` on day one and a runbook that names every owner-gated step.

**Decision.**
- **Compose is run from the repository root.** `.env` sets `COMPOSE_FILE=infra/compose.yml` so
  interpolation (`DOMAIN`, `CADDY_MODE`, `POSTGRES_PASSWORD`) and `env_file` come from the same
  file. `docker compose -f infra/compose.yml` from the root would hand the containers the right
  file but interpolate those values from nothing.
- **Migrations are a one-shot.** Service `migrate` applies `packages/db/drizzle` and gates
  `api`/`worker` (`service_completed_successfully`). Every `up` repeats it; a no-op takes a second.
- **Two Caddy modes, one header/log/health policy.** `subdomains` (public, Let's Encrypt) and
   `single-origin` (tailnet/LAN, path routing, `/readyz` reaches the API, docs under
  `/docs`). Both set HSTS/`nosniff`/`X-Frame-Options`/`Referrer-Policy`/`Permissions-Policy`, write
  JSON access logs, forward one `X-Forwarded-For` and an `X-Request-Id`, and hold requests for 15 s
  while an upstream restarts (active health checks). Docs `SITE_URL` may carry a path; a Sätteri
  plugin prefixes author-written Markdown links with that base.
- **Probes are two endpoints.** `/healthz` is liveness (process up) on the API and the web
  (prerendered, so it is a static file in every adapter). `/readyz` is readiness (database
  reachable, 2 s budget) on the API only. Compose `HEALTHCHECK`s and Caddy watch the matching one.
 - **Logs are JSON lines; traces are opt-in.** `LOG_FORMAT` defaults to `json` in production. Set
   `OTEL_EXPORTER_OTLP_ENDPOINT` and the API exports OTLP/HTTP; unset, the SDK is never loaded.
   Bun 1.4 has no native OTel (`Bun.otel` does not exist), so this is the standard JS SDK +
   `@hono/otel`. The service name is set in `compose.yml` (`starterdough-api`), not in `.env`,
   where one row would label `api` and `migrate` the same.
 - **Backups are a workspace.** `@repo/backup` (`infra/backup`): `pg_dump` custom-format, S3/R2
   copy, retention, heartbeat, restore drill. Compose profile `backup`. No `BACKUP_S3_BUCKET` →
   on-box only, and the tool warns.
 - **Images and deploy are a workflow.** `.github/workflows/deploy.yml` pushes
   `{api,web,caddy,backup}` to GHCR on `main`. `DEPLOY_HOST` + `DEPLOY_SSH_KEY` then run
  `infra/scripts/deploy.sh` (checkout, `compose pull`, `up -d --wait`, `/readyz`). Rollback is
  `IMAGE_TAG=sha-…`. Preview environments per PR are left to Coolify/Dokploy.
- **Secrets stay out of git.** `provision.sh` writes a `chmod 600` `.env`. SOPS + age
  (`/.sops.yaml`, `infra/env/`) is the documented path to version and CI-deploy it; 1Password and
  Doppler are named alternatives. CI runs `bun audit --prod --audit-level=high` and `pip-audit`.
- **Load tests aim at the origin.** `infra/loadtest/k6/smoke.js`, run from the `grafana/k6` container
  (a throwaway `ghcr.io/hatoo/oha` container for raw throughput; nothing is installed on the box).
  The per-IP limiter reads `X-Forwarded-For` only with `TRUST_PROXY=true`, and Caddy overwrites the
  header anyway, so the script hits the API directly and gives each virtual user its own address.

**Alternatives.** Coolify/Dokploy as the only path (great products, a second control plane the
kit would have to document around); Watchtower (pulls `latest` unattended; a rollback is then a
race); shipping Grafana/Tempo as required services (2 GB RAM on a $5 VPS); `pg_dump` via `Bun.cron`
inside the API (ties backups to a process that may be draining); Redis for the rate limiter
(correct for many replicas, a second stateful service for a one-box kit).

**Consequences.** The owner still has to bring a VPS, a Tailscale tailnet or a domain, and an
off-box bucket. Compose on this machine is the verification (single-origin, alternate host ports).
`create-admin` shells out to `bunx --bun auth@latest`, which downloads the Better Auth CLI on every
run, so it is documented as a command you run from the checkout on the box (`provision.sh` installs
Bun for the deploy user) against the compose Postgres, which is published on loopback only
(`127.0.0.1:${POSTGRES_PORT:-5432}`), rather than inside the production API container.
`compose.yml` refuses to start without `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET`
(`${VAR:?…}`, shipped empty in `.env.example`): a working default for a secret is the one kind of
convenience that ends up in production. The Bun.SQL pool is kept on `globalThis` so `bun --hot` reloads reuse it instead
of opening `DATABASE_POOL_MAX` connections each.

## D30 · Production-readiness audit fixes: the commercial layer, the silent misconfigurations, and the parts around the happy path

**Context.** Sixteen read-only Opus reviewers audited the whole repository at `375834e` against
"could a buyer put this in production" (ROADMAP §11: 8 P0, 91 P1, 132 P2 before dedupe). The
security core held: no authorization hole in any of the procedures, no SQL injection, no
committed secret, no privilege escalation. What was not production-ready was
everything around the happy path: resource lifecycle, accounting under concurrency, configuration
that fails silently, and the fact that there was no licence at all. Twelve fix agents worked the
P0 and P1 items in disjoint file scopes (session 14, 2026-09-10); this entry records the decisions
that were not obvious from the finding itself.

**Decisions (headline).**

 - **There is a licence, and it is in the root manifest**: `THIRD-PARTY.md` carries the notice
   lines for the two dependencies that need one.
 - **Request bodies are bounded at every layer that can bound them**: Caddy and `Bun.serve`,
   rather than trusting `content-length`.
- **The service worker no longer caches navigations**, so an authenticated page (and the session
  token inlined in it) cannot outlive sign-out in a browser cache.
- **CSP everywhere a browser renders**: nonce/hash-based on the SvelteKit app with no
  `'unsafe-inline'` in `script-src` (mode-watcher's head script is disabled; `light-dark()` under
  `color-scheme` means an unclassed document already follows the OS, so only a visitor who forced
  a mode against their OS sees one frame of the other theme), static in both Caddyfiles for the
  Astro sites, and a Playwright test that fails on the first CSP violation.
- **An unreachable API is an outage, not a sign-out.** The app's guards classify a missing session:
  an answered 4xx redirects to `/login`; no answer or a 5xx renders a 503 page, so a dead API never
  logs everyone out.
- **The desktop build has its own output directory** (`apps/web/build-static`, via
  `STATIC_OUT_DIR`), so a Tauri build cannot overwrite a web build in progress.
- **`DOMAIN` and `IMAGE_REGISTRY` ship empty**, so a first `docker compose up` cannot chase
  certificates for a domain the buyer does not own or pull the seller's images.
- **`SITE_URL` is required for a production build of either Astro site**: unset or left on an
  `example.com` placeholder, `astro build` now fails instead of shipping canonicals, OG images, RSS
  links and a sitemap that point at somebody else's host. Dev and `astro check` keep a localhost
  fallback. The kit also ships no repository URL of its own in either site's chrome:
  `PUBLIC_REPO_URL` / `DOCS_REPO_URL`, unset means the links are not rendered.
- **The off-box backup copy is verified against the bucket**: a `stat` of the uploaded key and the
  manifest's SHA-256 before a live restore, replacing a comparison that could not fail.
- **Focus indicators are tokens that meet WCAG 2.2 SC 1.4.11** in both themes, ring offset
  included.
- **shadcn is the single component implementation**; `Button`/`Input`/`Select` become thin
  wrappers that keep the app's prop names (D23 mapping table) rather than a 220-call-site rename.
 - **Pagination cursors are opaque and carry the instant as text.** The driver hands JavaScript a
   millisecond `Date` for a microsecond `timestamptz`, so an ISO cursor, even as an `(iso, id)`
   tuple, skipped every row inside the truncated millisecond. `packages/db/src/cursor.ts` formats
   the instant with `to_char(… 'YYYY-MM-DD HH24:MI:SS.US')`, parses it back as `timestamptz`, and
   compares `(col, id)` as a row tuple; the API base64url-encodes `<instant>|<id>` and answers
   `BAD_REQUEST` for a forged one. Any procedure that pages uses it.
- **Escaping in email is structural, not per template.** An `html` tagged template escapes every
  interpolation and composes nested fragments without double-escaping; `layout` accepts only that
  type, so a template that forgets to escape is a type error. Header values are flattened (control,
  format and separator characters → space). Names are capped and normalised in Better Auth's
  `databaseHooks` (not `additionalFields`) so sign-up, social sign-in and profile updates all pass
  through one place.
 - **Production refuses to boot on the silent misconfigurations**: no `RESEND_API_KEY`, an
   `EMAIL_FROM` on a localhost/example/reserved/dotless domain, a `COOKIE_DOMAIN` that is not a
   bare hostname covering both `WEB_URL` and `API_URL`, and `SKIP_ENV_VALIDATION` no longer
   means "unparsed": the schema always runs with coercions and defaults, only the production
   cross-field rules are skipped and the two secrets get placeholders.
- **Restore refuses instead of guessing.** Manifest SHA-256 is never overridable; a database-name
  mismatch and connected writers need explicit flags; `--single-transaction --exit-on-error` under
  a `lock_timeout`; one restore at a time through an advisory lock; `list` exits 1 past
  `BACKUP_MAX_AGE` so a monitor can page on a stale set. Dumps stay plaintext; the bucket is
  hardened (versioning, write-only credential, lifecycle) rather than the artifact encrypted.
- **Control characters are refused at the contract**, once, on every free-text input, instead of
  sanitised at each sink (email subjects, `content-disposition`, log lines). The rule carries
  `params.reason = 'control_characters'` so a UI can phrase it in the user's language.
- **Version has one source**: the root `package.json`. The Tauri config, Cargo manifest, native
  package manifest, API `/health`, `/admin/system` and the OpenAPI document are generated from or
  read it; none carries a copy to edit.
 - **The kit ships no origin of its own.** `DOMAIN`, `IMAGE_REGISTRY` and `COOKIE_DOMAIN` are
   empty in `.env.example`; `provision.sh` derives the registry from the fork it clones; CI builds
   the static sites against `.invalid` canonical URLs; the issue templates and Cargo manifest keep
   the kit's own repository slug because `scripts/rename.ts` rewrites it.
- **Bash is not an editor.** Every agent in the wave edited through Read/Edit/Write or Ultra Edit
  because the Bash tool collapses one level of backslash escaping silently; the one heredoc that
  slipped through wrote a NUL byte into `scripts/rename.ts`. The Write/Edit tools in turn decode
  backslash-u escapes into literal characters, which is why control-character checks are written
  as code-point loops rather than regex literals.

**Alternatives.** Encrypting dumps (deferred: an `.enc` artifact kind touches every backup command;
bucket hardening covers the stated threat). A 40 px button scale for the shadcn wrappers (the four
shadcn composites render shadcn buttons internally and would diverge from the registry).
`ring-ring/50` with a darker token (measured 1.96:1 even with the fixed token). Migrating the 220
call sites to shadcn prop names (mechanical churn for no behaviour). Deleting duplicate rows in a
migration (a migration must never silently delete a buyer's rows; it aborts and names the key,
with the de-duplication queries in its header).

**Consequences.** `db:migrate` can fail on a production database with duplicate passkeys, by
design, with the fix-up SQL in the migration header. The per-IP rate limiter is in-process:
several API replicas need a shared store first. Production deploys need a real email provider and
sender domain before the API starts. The app is 32 px dense with a tinted danger button and a
visible input border; the dark dialog scrim is 65 %. The `auth` CLI is pinned to the installed
`better-auth` version and the two are bumped together.
