# @repo/web

The application: auth, the account area and the platform admin. SvelteKit + Svelte 5 + Tailwind v4.

It is a **thin client** of `@repo/api`: no database access, no server-only business logic.
`load` functions and components call the API through `@repo/api-client`. Auth goes through
`@repo/auth/client`.

## Build targets

| Command | Adapter | Use |
| --- | --- | --- |
| `bun run build` / `build:node` | `adapter-node` | Self-hosted container (see `Dockerfile`) |
| `bun run build:cloudflare` | `adapter-cloudflare` | Cloudflare Workers (`wrangler.jsonc`) |
| `bun run build:static` | `adapter-static` (SPA) | Tauri desktop/mobile shells, any static host |

The static build sets `ssr = false` and switches auth from cookies to bearer tokens
(`src/lib/token-store.ts`). `bun run dev:static` is the same thing as a dev server on port 5175.
The Tauri shell's `dev:desktop` runs it.

## Develop

```sh
cp .env.example .env
bun run dev            # http://localhost:5173; expects the API on :3000 (`bun run dev:app` at the root starts both)
bun run check          # compiles messages, then svelte-check
bun run test           # Vitest: unit (node) + component (Chromium via Playwright)
bun run test:e2e       # Playwright against a production preview (axe + locale resolution)
bun run i18n:compile   # messages/**.json → src/lib/paraglide (the Vite plugin does this on dev/build)
```

## Languages

Text lives in `messages/{en,de}/<area>.json` (`common`, `public`, `auth`, `shell`, `app`,
`account`, `admin`). Keys form one flat namespace, `<area>_<page>_<element>`. Paraglide compiles
them into `src/lib/paraglide/` (gitignored). Options: `project.inlang/paraglide.config.ts`.
Locales: `project.inlang/settings.json`.

In components: `import { m } from '$lib/paraglide/messages'` and `{m.auth_login_title()}`.

The locale is resolved from the `PARAGLIDE_LOCALE` cookie, then `Accept-Language`, then `en`.
`LocaleSwitcher` (Settings, public pages) sets the cookie and reloads.

To add a language: add it to `locales`, add `messages/<locale>/*.json` and a `zod/locales` entry in
`$lib/i18n.ts`.

## Platform modules (`src/lib`)

| Module | What |
| --- | --- |
| `api.ts` · `auth.ts` · `token-store.ts` | typed API client (`api`, `apiFor(fetch)`), Better Auth client (`authClient`, `authFor(fetch)`), bearer storage for the static build |
| `query.ts` | `orpc`, TanStack Query utils over the contract; `getQueryClient()` (one per browser session, provided by the root layout; queries disabled during SSR) |
| `forms.ts` · `schemas.ts` | `spaForm` options, `zodForm` (Zod adapter that phrases every issue in the user's language) and `applyApiError` for superforms in SPA mode; Zod schemas for the forms without a contract procedure (auth, organization) |
| `i18n.ts` · `paraglide/` | locale helpers over the generated Paraglide runtime: `switchLocale`, `localeName`, `formatDate/DateTime/Relative/Number`, `applyZodLocale`; `paraglide/` is generated from `messages/` |
| `pwa.svelte.ts` | service-worker registration (production browsers only) and the install prompt (`pwa.canInstall`, `pwa.install()`) |
| `analytics.svelte.ts` | PostHog behind `PUBLIC_POSTHOG_KEY` *and* the visitor's consent; `capture/identify/signOut` are no-ops otherwise |
| `components/` | `CommandPalette`, `ThemeToggle`, `LocaleSwitcher`, `ConsentBanner`, `FormField` |
| `flags.ts` | `flagsFor(fetch)` (called in the `(app)` layout load) and `flag('key')` for components |

`src/hooks.client.ts` and `src/hooks.server.ts` load Sentry only when `PUBLIC_SENTRY_DSN` /
`SENTRY_DSN` is set and attach a reference id to unexpected errors. `hooks.server.ts` also resolves
the request's locale (`paraglideMiddleware`) and fills `%lang%`/`%dir%` in `app.html`.
`src/service-worker.ts` is the offline shell (`/offline` is prerendered). `e2e/a11y.e2e.ts` runs
axe on the public pages; `e2e/i18n.e2e.ts` checks locale resolution and the switcher.

## Routes

| Route | What |
| --- | --- |
| `/` | landing |
| `/healthz` | liveness probe (`{ "status": "ok" }`), prerendered; used by the container HEALTHCHECK and Caddy |
| `/offline` | prerendered fallback served by the service worker when a navigation fails |
| `/login` · `/signup` · `/forgot-password` · `/reset-password` · `/verify-email` · `/two-factor` | auth (`(auth)` group; buttons follow `system.authConfig`) |
| `/app/**` | authenticated shell; `(app)/app/+layout.ts` redirects to `/login?next=…` without a session |
| `/app/settings` · `/app/settings/security` · `/app/settings/sessions` | profile, email & password, 2FA + passkeys, sessions, delete account |
| `/app` | the signed-in landing page |
| `/admin/**` | platform administrators only (`isAdmin(user.role)`, universal guard in `(admin)/admin/+layout.ts`): `/admin/users` (admin plugin: search, ban, role, impersonate, sessions), `/admin/flags`, `/admin/system` |

Emailed links (verify, reset, change-email, delete) hit the API (`/api/auth/*`) and redirect back
to these routes with `?token=` or `?error=`. In development the emails are printed to the API
terminal.
