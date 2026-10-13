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
gap either way. When this was decided, SvelteKit 2.70 was stable and SvelteKit 3 was in prerelease
with no further breaking changes planned. SvelteKit 3.0.0 went GA on 2026-10-01 (3.0.1 on
2026-10-06).

**Decision.** SvelteKit with Svelte 5 runes. Configured in the SvelteKit 3 style from the start
(adapter inside the `sveltekit()` Vite plugin), and on SvelteKit 3 itself from the kit's 1.0.0
release. Three adapters, selected by `ADAPTER`: node, cloudflare, static.

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
   contract where one exists (a procedure's `.input()`) and live in `#lib/schemas.js` otherwise
   (auth, account).
  `spaForm` in `#lib/forms.js` carries the common options; `applyApiError` maps an oRPC failure
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
  page views come from `afterNavigate`, shallow navigations excluded. The service worker
  (`src/service-worker/index.ts`: precache + network-first + prerendered `/offline` fallback) is
  registered by `#lib/pwa.svelte.js` in production browsers only, never in dev, never in the Tauri
  shells; the same module captures `beforeinstallprompt` for an "Install app" button.
- **Accessibility is tested.** `@axe-core/playwright` (WCAG 2.2 AA) runs in `test:e2e` on the
  public pages plus a skip-link test; the authenticated pages were axe-clean in the verification
  pass in both modes (the dark-mode danger button needed `--destructive-foreground` to flip to
  dark text; white on the lighter dark-mode red is 2.8:1).

**Alternatives.** Growing the hand-written set (weeks of accessible primitives for no gain);
shadcn-svelte inside `apps/web` (the Astro sites and future surfaces would copy components);
`:root`/`.dark` token blocks (the sites would need a class-toggle script to follow the OS);
SvelteKit form actions (no server in the static build, and a second validation path beside the
API); Svelte stores for data (v5 of svelte-query was store-based and unreliable under runes);
`@vite-pwa/sveltekit` (a generator over the same build manifest, `$app/manifest` in SvelteKit 3;
not needed for one worker); statically importing Sentry (≈460 KB minified in every deployment).

**Consequences.** The client ships bits-ui + floating-ui + sonner (≈276 KB minified, shared
chunk) on every page of the app. Components added later must be exported from
`packages/ui/src/index.ts` (namespaced when multi-part). `taintedMessage` is off by default;
enable it per form where unsaved edits matter. Flags are read once per session; `refreshAll()`
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
  REST API's text) and the web does not strip it: `zodForm(schema)` (`#lib/forms.js`) validates
  and then phrases each issue from its `code`/`format`/`params` (`issueMessage`), falling back to
  Zod's own message, which `applyZodLocale` (`#lib/i18n.js`) localises with `zod/locales` on the
  client. Rules that need recognising carry `params` (the reserved-slug refine →
  `{ reason: 'reserved_slug' }`); web-owned schemas (`#lib/schemas.js`) use lazy messages
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
 - **Images and deploy are a workflow.** `.github/workflows/deploy.yml` is opt-in
   (`DEPLOY_ENABLED`) and runs after CI passes on `main` (`workflow_run`). It pushes
   `{api,web,caddy,backup}` to GHCR, then `DEPLOY_HOST` + `DEPLOY_SSH_KEY` push the commit
   into the server's checkout and run
  `infra/scripts/deploy.sh` (checkout, `compose pull`, `up -d --wait`, `/readyz`). Rollback is
  `IMAGE_TAG=sha-…`. The server never fetches from GitHub, so a private repository needs no
  deploy key on the box. Preview environments per PR are left to Coolify/Dokploy.
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

## D32 · CSRF: a header on `/rpc`, an origin check for cookie writes on `/api/v1`

**Context.** Both procedure transports accept the session cookie, and oRPC parses form-encoded and
multipart bodies as well as JSON, so a plain HTML form can reach a procedure. Better Auth's cookie
is `SameSite=Lax`, which keeps it off a POST from another site but not from a sibling subdomain:
`blog.example.com` and `api.example.com` are the same site. Nothing checked `Origin`, a header or a
token; CORS only decides who may read the answer, and a form does not ask.

**Decision.** Defence in depth, one mechanism per transport, both reading `trustedOrigins()`.
`/rpc/*` requires `x-csrf-token: orpc` (oRPC's `SimpleCsrfProtectionHandlerPlugin`), and
`@repo/api-client` sends it on every call (`SimpleCsrfProtectionLinkPlugin`), so the browser, SSR
through `apiFor(fetch)` and the static shells all comply without code of their own. A form cannot
set a header, and a page on another origin can only after a CORS preflight, which the API grants
to trusted origins alone (`X-CSRF-Token` is in its allowed headers). `/api/v1/*` is for curl,
Python services and third parties, so it asks for no header; `middleware/csrf.ts` refuses only a
write (not `GET`/`HEAD`/`OPTIONS`) that carries a cookie and whose `Origin` is not trusted, or that
has no `Origin` and a `Sec-Fetch-Site` of `cross-site` or `same-site`, with
`403 { error: 'forbidden_origin' }`.

**Alternatives.** The header on both transports (breaks every curl and Python caller of REST that
uses a bearer token, which no browser forges). A synchronizer token (state per session and a fetch
before the first write, for no gain over a header a form cannot send). `SameSite=Strict` (signs a
visitor out of every link that arrives from another site). Checking only Better Auth's session
cookie by name (its name varies with `__Secure-` and the prefix; any cookie is enough to call a
write forged).

**Consequences.** A client of `/rpc` built without `createApiClient` must send the header. A
browser page that writes to `/api/v1` with the cookie must be on `WEB_URL` or in `TRUSTED_ORIGINS`.
A server-side caller that forwards a cookie and sends neither `Origin` nor `Sec-Fetch-Site` passes,
as does every request without a cookie.

## D33 · Two migration histories: the kit's and the product's

**Context.** Drizzle's migrator applies a migration only when its journal `when` is newer than the
newest one already applied. Until 1.1.0 a product's `db:generate` wrote into the kit's own history,
`packages/db/drizzle`, so a kit release that added a migration collided with every product that had
generated one. The merge conflicted on the journal and, add/add, on the snapshot. The resolution
that looks right, renumbering the product's migration after the kit's and keeping its `when`, left
the kit's migration older than one every product database had already applied: `drizzle-kit
generate` said "No schema changes", and `db:migrate` stopped with the kit's migration pending.
Every kit release with a migration would have needed each product to rebase its history.

**Decision.** Two Drizzle histories, applied inside the one advisory lock, the kit's first.

- **The kit's** is `packages/db/drizzle`, generated from `src/schema/index.ts` through
  `drizzle.kit.config.ts` and recorded in `drizzle.__drizzle_migrations`. Only kit releases write
  it: the seller generates a kit migration with `bun run --cwd packages/db generate:kit`, and a
  product never runs that.
- **The product's** is `packages/db/drizzle-product`, generated from `src/schema/product.ts`
  through `drizzle.config.ts` and recorded in `drizzle.__product_migrations`. Being the default
  config, it is what `db:generate` and any bare `drizzle-kit` command (`drop`, `check`) act on. The
  kit ships it empty and never changes it.
- **A product's change to a kit table** (a Better Auth plugin or extra field, an index of its own)
  is a custom migration in the product's history. `bun run db:kit-drift` prints the SQL Drizzle
  would write for it, minus what a product migration already holds, and `kit-drift.test.ts` fails
  while any is outstanding; in the kit's own repository the same test catches a forgotten
  `generate:kit`. `schema-coverage.test.ts` checks every declared column against a migrated
  database, and `migration-files.test.ts` checks both histories' files without one.
- **A product with migrations from before 1.1.0** moves them once, while the 1.1.0 merge is open,
  with `bun run db:move-product-migrations`, which keeps their SQL, hash and `when`. `migrate.ts`
  then moves their history rows to the product's table (`rehomeProductMigrations`) before either
  history runs, so a production database changes only through the deploy's migrate step. Both are
  one-shot tooling, to remove in 2.0.

This amends D6 (migrations are committed under `packages/db/drizzle/` and, for a product's own,
`packages/db/drizzle-product/`), D22 (`admin.system.status` reports both histories) and D28 (the
`migrate` one-shot applies both).

**Alternatives.** One history and a migrator that applies whatever is unapplied, whatever its
order, plus a rebase of the product's migrations at each kit release that adds one (a fork of
Drizzle's migrator, a conflict at every such merge, and no way across to the full edition for a
free database with migrations of its own). One schema split between the generators with
`tablesFilter` (`drizzle-kit generate` is offline and diffs exactly what its schema file exports; a
filter cannot say whose a table is). One journal with index ranges reserved for each side (Drizzle
orders by `when`, not by index). `drizzle-kit check` as the merge check (it exited 0 on a naively
merged product branch that `migration-files.test.ts` rejects).

**Consequences.** The order differs between a fresh database, which runs every kit migration and
then every product one, and an existing one, which runs a new release's kit migrations after the
product's. Kit migrations never reference product tables. A product migration must not depend on
kit state a later release changes, or it fails on fresh databases, and a later kit migration that
takes a name a product already used fails on existing ones. Changing a kit table takes a
hand-placed custom migration, which is less automatic than `db:generate` was. Two of a product's
own branches that each generate a migration still collide the usual Drizzle way:
`migration-files.test.ts` catches the naive merge and UPGRADING.md's "Migrations" gives the
remedy. Once `rehomeProductMigrations` has moved a database's rows, a build from before 1.1.0
cannot migrate it any more (it would run the moved migrations again), so rolling back across
1.1.0 means restoring the dump taken before it. In the kit's own repository a bare `drizzle-kit`
command now acts on the empty product history; `db:generate` there says "No schema changes",
which is harmless, and kit migrations come only from `generate:kit`.

## D34 · Product files: one per registry, never edited by the kit, marker-free when shared

**Context.** Until 1.1.0 a product's feature lived partly in kit files. Its procedures were spread
into `contract` in `packages/api-contract/src/index.ts`, its router was mounted in `router.ts`, its
messages went into the kit's catalogues and its links into the app shell's lists, and each of those
files changes in most kit releases. "Put your code in new files" (`UPGRADING.md`) cannot cover a
registry: something has to list the new file, and that line sat in a kit file. Every such line was
a conflict waiting for the next release that touched the same hunk.

**Decision.** Each registry a product extends has one product-owned file, next to the kit code that
reads it. The kit created each in 1.1.0 as an empty stub, edited its reader once to take the file's
entries last, and never changes the file again; a later extension point arrives as a new file.

- **Shared by both editions, without markers, byte for byte:** `packages/db/src/schema/product.ts`,
  `packages/db/src/product.ts` and `packages/db/drizzle-product/` (D33);
  `packages/api-contract/src/product.ts`, spread last into `contract` and re-exported whole by
  `@repo/api-client`; `apps/api/src/rpc/product.ts`, spread last into the router;
  `apps/web/messages/{en,de}/product.json`, one more Paraglide catalogue; and
  `apps/web/src/lib/product.ts`, whose `productNavLinks` the sidebar and the command palette show
  before Settings.
- **A product file imports kit modules, never the kit file that imports it**, which would be a
  cycle: a contract file of the product's builds on `procedures.ts`, never on `index.ts`.
- **The names are the product's.** `product.ts`, `product-*.ts`, `product.json` and anything in
  `drizzle-product/` are never the kit's own files.

**Alternatives.** A registry filled at runtime, where product modules register procedures and
links with the kit (the contract would lose the static types the client and the OpenAPI document
are built from). One `product/` directory per app (the files would sit away from the code that
reads them, which still needs the same one-line hook). A product's additions inside the kit files
between agreed markers (a merge still conflicts on lines both sides touch). Edition markers inside
the shared product files (the free and paid stubs would differ, so moving a free product to the
full edition could not simply keep the product's side of each file).

**Consequences.** A product's feature edits no kit file, so a kit release merges without touching
it, and moving from the free edition to the full one keeps the product's side of every shared
product file while the paid-only ones arrive as new files. A key the product shares with a kit
procedure fails `bun run check`, because the product's entries come last; a schema of the
product's with the name of a kit export is shadowed in `@repo/api-client` without an error. Some
changes still mean editing a kit file, as the docs' "Where your code goes" lists: Better Auth's
configuration and the self-hosted stack.
The kit's own changes to a registry's shape ship as new files or as new kit code around the
product file, never as an edit to it.

## D35 · `kitVersion` is the kit's release, `version` is the product's

**Context.** Until 1.1.0 the root `package.json` `version` was the kit's release, and D30 made it
the one source every surface reads: `/health`, `/admin/system`, the OpenAPI document, the telemetry
resource, the site and the desktop builds. A product built on the kit has releases of its own and
reports them through those same surfaces. A product that bumped `version` conflicted with every kit
release that bumped it too, and one that did not reported the kit's release as its own.

**Decision.** Two fields in the root `package.json`.

- **`version` is the product's.** The kit ships 0.1.0 there, in `apps/native/package.json` and in
  `apps/native/src-tauri/Cargo.toml`, and never changes it again. Every surface D30 lists reads it.
- **`kitVersion` is the kit's release**, and only kit releases change it. It sits after
  `packageManager`, lines away from `version`, so a release's bump and a product's merge without a
  conflict. `/admin/system` shows it to platform admins. The public `/health` leaves it out: there
  it would tell anyone which kit release, and so which of its published issues, a deployment runs.
  Bug and vulnerability reports about the kit ask for it.
- **The free edition** carries both fields as the kit does, and each of its releases is named and
  tagged from `kitVersion`.
- **`bun run rename` leaves `version` alone.** Every kit snapshot from 1.1.0 on already carries
  0.1.0, and a rename run on a `main` with a version of its own would lose it.

This amends D30's "Version has one source": the product's version still has one, `version`, and
the kit's release is the separate `kitVersion`.

**Alternatives.** Keep `version` as the kit's and give the product a field of its own (every
surface would report the kit's release, and a product would have to change each one). A version
file of the kit's outside `package.json` (one more root file, read by tooling that already reads
`package.json`). The kit release on `/health` as well (it fingerprints every product built on the
kit). A reset of `version` in `rename` (it would wipe a real version on a renamed `main`).

**Consequences.** The one change from 1.0.0's `version` to 0.1.0 conflicts for a product that set
its own, and UPGRADING.md says to keep theirs; a product that never set one starts at 0.1.0. From
then on neither side edits the other's line. A deployment that is the kit itself, such as the
seller's demo, sets `version` to the kit's release on every release, or it reports 0.1.0.


## D37 · What a renamed product publishes

**Context.** `bun run rename` rewrote the kit's name, but a product built on it still published the
kit. Its marketing site served the kit's release notes for 0.1.0 to 1.0.0, licence-sale terms
included, and the kit's two blog posts. Its docs site served the kit's developer manual, and the
site's buttons linked into manual-only pages. The legal templates went live with their
`**[placeholders]**` and review note. The demo banner linked to the seller's site, and
`provision.sh` cloned the kit's repository when `REPO_URL` was unset. After the rename, the deploy
scripts' variables (`<SLUG>_STATE_DIR` and the like) kept the kit's slug, and the first `bun add`
re-sorted every renamed dependency map, so each later renamed release conflicted inside those maps.

**Decision.** What a deploy publishes is the product's by default, and the kit's own material stays
in the repository.

- **The site's changelog and blog are product-owned.** Each ships one sample marked `draft: true`,
  which `astro dev` shows and every build, the RSS feed, the OG images and the sitemap leave out
  (`published()` in `apps/site/src/lib/content.ts`, Astro's draft convention). The pages say "No
  releases yet." and "No posts yet." until there is an entry. The kit's history is `CHANGELOG.md`
  only, and no release after 1.1.0 adds or changes a file in either folder.
- **`apps/docs` has two content sets, chosen at build time by `DOCS_CONTENT`.** `product`, the
  default, is `src/content/product`: a splash page, a getting-started guide and the interactive API
  reference, with a sidebar generated from its folders so a product adds pages without editing
  `astro.config.mjs`. `kit` is the developer manual, left at `src/content/docs` so every reference
  to its path keeps working, with the sidebar it had. `content-set.mjs` decides for both the config
  and the collection's loader, and Astro's content cache is kept per set. `DOCS_CONTENT` is never an
  `.env` row: `loadSiteEnv` loads every row into the build, so a stored `kit` would publish the
  manual from every local build and every `deploy:cloudflare`. It is set per command
  (`bun run dev:manual`), per CI step and per Docker build arg. CI and the free edition's publish
  gate build the manual too, so a broken page still fails somewhere. The site links into the docs
  only at pages both sets have: the home and the API reference.
- **Legal templates are refused where they would be published.** `getStaticPaths` of
  `legal/[slug].astro` checks the documents it renders (`apps/site/src/lib/legal.ts`): a production
  build for a real origin fails while one holds a bold `**[...]**` placeholder or the "Template:
  review with counsel" note, outside HTML comments, and names each file. Loopback and the reserved
  `.invalid`, `.test`, `.localhost` and `.example` names are never checked, so CI, the publish gate
  and local builds are unchanged. `ALLOW_LEGAL_PLACEHOLDERS=1` opts out, from the build
  environment, `apps/site/.env`, the caddy and demo-static build args or a repository variable.
- **The rename finishes the job.** An uppercase rule rewrites `<SLUG>_` in variable names (a dash
  becomes an underscore); it matches only a prefix followed by `_` and runs before the name rule, so
  a product named in capitals keeps prose and variable names apart on a second rename. Dependency
  maps in a rewritten `package.json` are sorted in the order `bun add` keeps. "Starterdough kit"
  joins the verbatim strings, for pages that say what the product is built on. The kit itself keeps
  its variable names.
- **What the rename cannot rewrite is named.** `bun run doctor` gains a warning level (`!`), which
  never fails a run, for `.env` rows that still name the product renamed away from; it names rows,
  never values. The demo banner links to `PUBLIC_DEMO_CTA_URL`, and nowhere while it is empty.
  `infra/demo/.env.example` ships its domain, sender and registry empty, and `provision.sh` requires
  `REPO_URL`.

**Alternatives.** Hiding the changelog and blog navigation when they are empty (more code for a page
that says so itself). Moving the manual out of `apps/docs` (every repository reference to its path
would break). Leaving the docs out of a deploy (it would drop the API reference, which is product
documentation, and leave `docs.<domain>` dangling). A `DOCS_CONTENT` row in `apps/docs/.env`
(above). The legal check in `astro.config.mjs` (it would check files the build does not render, and
the reference demo renders a collection of its own). Renaming the kit's own variables (a
compatibility read in the kit and in every deployment, for a name only the rename needs to change).
A blocking doctor check (keeping the old database role and Compose project is right for a volume
kept on purpose, so it would fail for ever).

**Consequences.** After a rename, `docs.<domain>` serves a two-page skeleton until the product
writes its docs, and a buyer who wants no docs site still has the vhost. A product that edited the
kit's notes or posts meets a modify/delete conflict on its 1.1.0 merge, and a renamed fork sees the
variable prefix and the dependency maps change once; `UPGRADING.md` covers both. The legal check
knows only the templates' bold grammar: a placeholder a product writes unbolded passes, and a
deliberately bold bracketed phrase in a real policy is flagged. The doctor's sender heuristic flags
a display name without the product's name, such as "Support Team", which is why it only warns. The
kit's own reference deployment builds the manual and opts out of the legal check explicitly.

## D38 · Operating a product without a shell: release backups, pinned hosts, ops workflows, API errors

**Context.** By 1.0.0 the kit deployed from CI, but running a product still took an SSH session on
its server: to back up, read logs, create the first administrator, or get past a migration that
failed. Migrations are forward-only, yet `deploy.sh` ran them with no restore point, and the deploy
job had no timeout. Every SSH connection used `StrictHostKeyChecking accept-new`, which on a hosted
runner, whose `known_hosts` is empty in every job, accepted whatever key answered. `DEPLOY_PATH`
defaulted to `/opt/starterdough` and nothing checked that the checkout it named was this product's,
so one product could deploy into another's checkout after overwriting its `.env`. The off-site
backup credentials reached every container built from the API image, the API reported its errors
nowhere but its logs, base images floated on tags such as `oven/bun:1.4`, and CI spent macOS and
Windows minutes on installers a product might never ship.

**Decision.** The owner operates the product from GitHub Actions, and reaches the box with a shell
only to break glass.

- **A release backup before every deploy.** `deploy.sh` runs the backup tool's `backup --release`
  under the deploy's host lock, after the pull and the pre-deploy hooks and before anything stops:
  the tool's restore format (manifest, checksum, drill), not a second script. Release sets are
  online and hold the database only, since `pg_dump` reads one consistent snapshot and migrations
  never touch files. They stay on the box in `release/`, ping no heartbeat and are pruned to the
  newest four: they guard against a bad migration, not against losing the box, and a bucket outage
  must not block a deploy. A first deploy, whose database has no tables, skips it, and
  `RELEASE_BACKUP=off` is the one switch, for provider snapshots or a database too large to dump
  each time.
- **Backups wait for each other.** A release backup waits up to 10 minutes for the backup tool's
  advisory lock and a scheduled one up to 30; a manual backup and every restore still refuse at
  once. Refusing would fail a deploy that lands during the nightly run, and page someone when the
  nightly run met a release backup.
- **Four ops workflows**: Server status, Server logs, Server backup and Admin bootstrap, each run by
  hand in the `production` environment and gated on `DEPLOY_ENABLED` like Deploy. They ship
  `infra/scripts/ops.sh` from the runner on every run, so they work against a checkout of any age,
  and take the host lock only to change something, waiting up to 10 minutes for it. None joins
  Deploy's concurrency group, where GitHub would cancel a release waiting its turn. Recover
  deployment skips the `DEPLOY_ENABLED` gate, so switching deploys off in an incident cannot lock
  the owner out. In a public repository Server logs refuses to run and Server status leaves out log
  lines, because anyone can read those runs. Admin bootstrap hands the password to the script on
  its standard input, never on a command line or into the container's environment. A live restore
  is not among them: it stays a deliberate act on the box.
- **`abandon` in Recover deployment** drops a forward-only journal after a migration that fails
  every time, which would otherwise block every deploy, the fix included. It needs the first 7
  characters of the journal's revision and the recorded checkout, and starts nothing.
- **Identity before any change.** `DEPLOY_PATH` is required. Before the server's `.env` is
  replaced, its checkout must share history with the release (`git merge-base`) and resolve to the
  expected Compose project: the `name:` in `infra/compose.yml`, or the repository variable
  `COMPOSE_PROJECT_NAME`. The Deploy step checks the project again under the lock, and every ops
  command checks it too. History alone cannot tell two products built from the kit apart, since
  both carry the kit's. The recovery journal, now version 2, records the project Compose resolves
  and a kind (`stack`, `demo`) in place of the hard-coded project names.
- **Pinned host keys.** `DEPLOY_KNOWN_HOSTS` holds the server's host key, every connection runs
  `StrictHostKeyChecking yes` under one `HostKeyAlias`, and `provision.sh` prints the key with its
  fingerprint.
- **Backup credentials only where backups run.** `x-api-env` blanks the off-site keys and the
  heartbeat URL for every service built from the API image (`environment` wins over `env_file`),
  and CI checks the resolved configuration with sentinel values.
- **API errors to Sentry** through `@sentry/node`, loaded only while `SENTRY_DSN` is set. Errors
  only: OpenTelemetry keeps the traces and `lifecycle.ts` the fatal path, so Sentry's own handlers
  and its HTTP, fetch, console and local-variable integrations are off. Reports come from explicit
  call sites, and a `Failed query:` message is withheld, because Drizzle's carries the statement
  and every bound value.
- **Pinned images, and minutes spent where they count.** Base and service images are pinned to the
  patch release their floating tag pointed to (the same digest), `oven/bun` to `packageManager`,
  and `infra/scripts/image-pins.test.ts` holds both.
  Desktop builds wait for `DESKTOP_ENABLED`, CI's Rust job runs only while `apps/native` exists,
  and a pull request builds only the images whose inputs it changed.
  The server keeps its three newest local builds, and a weekly registry cleanup keeps version tags,
  `latest`, `main` and the 20 newest builds of each image.
- **Hooks for a product's own deploy steps**, in `infra/scripts/hooks/{pre,post}-deploy.d/`, which
  the kit never writes to, so a product's operations never edit `deploy.sh`.
- **One product per server**, with the setup a second product on the box needs documented rather
  than shipped: its own Linux user, ports, a shared Caddy over the proxy network and memory caps on
  both databases differ from box to box.
- **A 180-minute deploy job timeout**: the waits a legitimate rollout can meet before `deploy.sh`
  stops a writer add up to about 140 minutes, so the timeout only ever catches a hang.

This amends D28. Its consequence that `create-admin` downloads the Better Auth CLI through `bunx`,
and so runs from the checkout on the box rather than inside the API container, no longer holds: the
script uses the kit's own auth configuration, and Admin bootstrap runs it inside the running API
container.

**Alternatives.** A release backup with the writers stopped first (it adds the dump's duration to
every deploy's outage). The reference deployment's own `release-backup.sh` (a second script and
set format beside the tool's). Release sets copied off the box (a bucket outage would block
deploys, for a copy the nightly run makes anyway). A generic coordinated, writers-paused backup
mode (about 350 lines and a crash journal of its own where the reference deployment built one; the
online set and the drill's database-to-file check say what they cover). Refusing instead of
waiting on the backup lock, and trust on first use for host keys (above). A logger sink that
forwards errors to Sentry (every log call would become a report path nobody sees at the call).
`@sentry/bun` (it adds the `@apm-js-collab` instrumentation packages, where `@sentry/node` was
already in the lockfile through `@sentry/sveltekit` and captures and flushes on Bun 1.4.2). Ops
workflows in Deploy's concurrency group (above). A shipped overlay for a second product on a box
(every box differs).

**Consequences.** The two required variables stop every existing deploy until they are set; it
fails in the plan job, before anything is built. A release backup costs a dump's time and disk on
every deploy, with four sets kept on the box. It is online, so writes made while it runs are not in
it, and restoring it after the new release has served traffic loses that traffic's writes. A
nightly backup that runs longer than 10 minutes still fails a deploy that lands during it, which is
then run again. `abandon` lets an owner deploy old code over a newer schema, so the runbook restores
the release set first, and it cannot drop a journal a 1.0.0 deploy wrote. In a private repository
every collaborator can read the ops workflows' output. Promoting an account in Admin bootstrap needs
no secret, so whoever can run workflows can promote one; they can deploy code already, and required
reviewers on `production` close it. `@sentry/node` is not Sentry's documented SDK for Bun, so a
future major may need `@sentry/bun`, and the fatal path waits up to 2 s for Sentry before it exits.
Bun moves by hand with `packageManager`. A rollback to a build older than the newest 20 deploys a
version tag. The project check is the only guard between two products that both kept the kit's
name, so sharing a box starts with a rename.

## D39 · Platform primitives: email in the user's language

**Context.** Every email the API sent was English: D24 left the API's emails out of scope,
because a stored language would need a Better Auth field and a migration. A product's own
template sat in the kit's `packages/email/src/index.ts`, next to the kit's, where any release
that changed that file could conflict with it.

**Decision.** A product adds to each primitive in a product file the kit's code reads (D34), never
in a kit file.

- **Email in the user's language, taken from the request.** Each template is
  `defineTemplate({ en, de })`, a record over `EMAIL_LOCALES`, the app's own locales (a test keeps
  them equal), so a missing translation fails `bun run check`. Escaping stays structural: the
  `html` tag escapes every value. The web app's auth client sends the language it shows as
  `Accept-Language`, Better Auth hands every email callback the request, and `localeOf` picks the
  best language the kit writes email in, English otherwise. Nothing is stored per account.
- **Product files** (D34). `packages/email/src/product.ts` holds a product's templates in both
  editions, merged with the kit's, and a name the kit already uses stops the API at start-up.

This amends D24: the API's emails follow the user's language, without a stored preference.

**Alternatives.** A language stored per account (a Better Auth field and a migration, when the
request already says which language the person is using). Email copy in the app's Paraglide
catalogues (the API would read the web app's build output).

**Consequences.** An email no request causes, such as a digest sent on a schedule, has no language
to follow, so a product that sends one stores the person's choice itself. The German copy is
machine-drafted, like the app's (D24), and needs a native review before a launch.

