---
title: Frontend platform
description: What every screen is built from — the component kit, forms, data fetching, the app shell, PWA and offline, dark mode, i18n, and the deployment switches.
---

`apps/web` is a SvelteKit 2 / Svelte 5 application and a **thin client** of the API: no database
access, no server-only business logic. `load` functions and components call the API through
`@repo/api-client`; auth goes through `@repo/auth/client`. Everything below works on every target —
SSR on Node or Cloudflare, and the static SPA inside the Tauri shells.

## Components

`@repo/ui` exports the app's form vocabulary (`Button`, `Input`, `Label`, `Select`, `FormField`,
`Alert`, `EmptyState`) and the shadcn-svelte components generated into the package (`Dialog`,
`DropdownMenu`, `Command`, `Tooltip`, `Popover`, `Sheet`, `Tabs`, `Card`, `Avatar`, `Badge`,
`Checkbox`, `Separator`, `Skeleton`, `Switch`, `Textarea`, `Toaster`). One copy for every surface.
`Button`, `Input` and `Select` are thin wrappers over the shadcn components — one implementation,
one 32 px scale, one focus treatment — keeping the prop names the pages use (`primary` /
`secondary` / `ghost` / `danger`, `sm` / `md` / `lg`, `invalid`; `Button href` renders an `<a>`).
Icon-only buttons, the `outline` / `link` variants and file inputs import the shadcn component
directly. `packages/ui/README.md` has the mapping table.

```sh
bunx shadcn-svelte@latest add <name> -c packages/ui   # then export it from packages/ui/src/index.ts
```

The CLI rewrites the `catalog:` ranges in `packages/ui/package.json`; restore them before
committing (the README shows the step). Icons come from `@lucide/svelte/icons/<name>`. `Tooltip`
needs the `TooltipProvider` the app's root layout mounts. In development `apps/web` serves
`/dev/ui`, every export in both themes with focus states visible — a 404 in every build.

## Theme and dark mode

`packages/ui/src/theme.css` holds shadcn's neutral token set as **`light-dark()` pairs** mapped in
`@theme inline`. With `color-scheme: light dark` every surface follows the OS with no JavaScript —
the Astro sites get dark mode for free. The app adds a Light/Dark/System toggle: mode-watcher writes
`.light` / `.dark` on `<html>` and persists the choice; the `dark:` variant matches both the forced
class and "OS dark unless `.light`". The tokens deviate from shadcn's neutral base where its
defaults miss WCAG 2.2 (`--ring`, `--sidebar-ring`, `--input`, `--muted-foreground`,
`--destructive`) and add `--overlay`, `--success*` and `--warning*`; `bun run --cwd packages/ui test`
recomputes every contrast ratio from `theme.css` and fails when one drifts (it is part of
`bun run verify`). Consumers import the tokens with

```css
@import 'tailwindcss';
@import '@repo/ui/theme.css';
```

## Forms

`sveltekit-superforms` in **SPA mode with Zod 4** — no form actions, because the API is the backend
on every target and the static build has no server. Schemas come from the contract where a
procedure exists and from `apps/web/src/lib/schemas.ts` otherwise (auth, account). `spaForm` in
`$lib/forms.ts` carries
the shared options and `applyApiError` maps an oRPC failure back onto fields or the form. Submit
buttons stay disabled until hydration, because a native POST to a page without actions is a 405.

## Data

`@tanstack/svelte-query` v6 with `@orpc/tanstack-query`: `orpc.account.me.queryOptions(…)` gives
the key, the fetcher and the types; mutations invalidate `orpc.account.key()`. Queries are
disabled during SSR (they would run without the session cookie) — pages render skeletons on the
server and fetch on the client, or load data in `load` with `apiFor(fetch)` when the HTML must
contain it. One `QueryClient` per browser session, provided from the root layout.

## App shell

Skip link and one `<main id="main">` per page; a responsive sidebar (a `Sheet` on small screens);
a command palette on Ctrl/⌘K (pages, theme, sign out); toasts after every mutation; dialog
confirmations for destructive actions; skeletons and empty states for every list; an error
boundary and error pages with a reference id; an "Install app" button when the browser offers it;
banners for unverified email and active impersonation.

## Feature flags

The `(app)` layout load fetches `system.flags`; components read
`flag('key')` from `$lib/flags`. Flags are created on `/admin/flags` (see [Admin](/guides/admin/)).

## PWA and offline

`static/manifest.webmanifest` and `theme-color` make the app installable. `src/service-worker.ts`
precaches exactly the build manifest — the immutable build output, the static folder and the
prerendered public pages, `/offline` among them — and serves only those from a cache. **No
navigation is ever cached.** A navigation to `/app` or `/admin` is one signed-in user's HTML, and on
a single-origin deployment `/api/*` is a same-origin GET as well; a cached
copy would hand the next person at that machine another user's page, or a live session token out of
DevTools. Everything outside the manifest reaches the network untouched, and only a navigation that
fails offline is answered — with `/offline`. A new build replaces the cache on activation, and
signing out clears it. The worker is registered in **production browsers only** — never in
development, and never inside the Tauri shells, whose files ship in the bundle. The same module
captures `beforeinstallprompt` for the install button.

## Security headers and CSP

The Content-Security-Policy for every page this app serves is **derived at build time** from the same
`PUBLIC_*` values the client is built with, by `csp()` in `apps/web/vite.config.ts` — which is also
where the whole SvelteKit configuration lives; there is no `svelte.config.js`. `connect-src` is
`'self'` plus the API origin, the Sentry DSN's host and PostHog's hosts
when those are configured, and a value that is not an absolute URL fails the build rather than the
page. `img-src` is `'self' data: blob:`, so a remote avatar — a GitHub or Google profile picture — is
blocked until you list its origin, which is how any third-party origin is added: by editing that one
function. `script-src` carries **no** `'unsafe-inline'`: the only inline script left on a page is SvelteKit's
own hydration bootstrap, which it nonces on a server-rendered page and hashes (sha256) on a
prerendered one. Keeping that true costs one thing — the root layout passes
`disableHeadScriptInjection` to `<ModeWatcher>`, so a visitor who forced a theme *against* their
operating system's preference sees one frame of the other theme before hydration.
`apps/web/e2e/csp.e2e.ts` loads `/`, `/login`, `/signup` and `/offline` in a real browser and fails
on a console CSP violation, or on an `'unsafe-inline'` creeping back into the directive.

`hooks.server.ts` adds `Cross-Origin-Opener-Policy: same-origin` to every page and
`Cache-Control: private, no-store` to `/app` and `/admin`, and strips `session.token` out of the
session response before SvelteKit inlines it into the HTML for hydration. `static/robots.txt`
disallows `/app` and `/admin`. The remaining browser headers come from Caddy — see
[Operations](/guides/operations/#caddy-modes).

## Internationalization

i18n uses **Paraglide JS**. Messages live in `apps/web/messages/{en,de}/*.json`, one file per area
of the app, and are compiled before `check`, `test` and `build` (`bun run i18n:compile` in
`apps/web`). The locale is resolved from a **cookie**, then the browser's **`Accept-Language`**,
then **`en`** — no URL prefixes, so the static SPA works unchanged. Users switch the language in
Settings.

## Deployment switches (all off by default)

| Switch | Variable | Behaviour |
| --- | --- | --- |
| Error tracking | `PUBLIC_SENTRY_DSN` (browser), `SENTRY_DSN` (SSR) | The Sentry SDK is imported dynamically only when a DSN is set — deployments without it ship none of it. Works on Node and Cloudflare. |
| Analytics | `PUBLIC_POSTHOG_KEY` | A consent banner appears; PostHog loads only after the visitor accepts. `analytics.capture()` is a no-op otherwise. |

## Accessibility

`bun run test:e2e` runs axe (WCAG 2.2 AA) on the public pages and checks the skip link; the
authenticated pages passed the same checks in both color modes. Dark-mode danger buttons use dark
text on the lighter dark-mode red, because white would not reach the required contrast.

## Conventions

 - Server-only code stays server-only: `@repo/db`, `@repo/auth/server` and `@repo/env` are never
   imported by `apps/web` or `apps/site`. Browser-safe surfaces: `@repo/auth/client`,
   `@repo/auth/permissions`, `@repo/api-client`, `@repo/ui`.
- Forms validate the contract's schema, never a copy.
- Components added later must be exported from `packages/ui/src/index.ts`.
- `apps/web` typechecks with `noUncheckedIndexedAccess`, `.svelte` files included, so an index
  access yields `T | undefined`. It cannot extend `packages/tsconfig/base.json` — SvelteKit owns the
  generated base its config extends — so that one rule is repeated in `apps/web/tsconfig.json`.
