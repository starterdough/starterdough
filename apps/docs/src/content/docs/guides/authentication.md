---
title: Authentication
description: Better Auth inside the API; cookies on the web, bearer tokens in the shells; email flows, social sign-in, two-factor, passkeys and sessions.
---

Better Auth runs **inside the API** (`packages/auth/src/server.ts`, mounted at `/api/auth/*`). The
frontends only use the client factory from `@repo/auth/client`. They never import the server
instance or the database.

## What ships

- **Email + password** with verification (`REQUIRE_EMAIL_VERIFICATION`, default on in production),
  password reset, change email (confirmed from the old address) and delete account (confirmed by
  email). Every email goes through `packages/email`: printed to the API console in development,
  sent with Resend when `RESEND_API_KEY` is set. Production **requires** that key and an
  `EMAIL_FROM` on a domain a provider accepts. Without them the API refuses to boot (see
  [Configuration](/start/configuration/)).
- **Social sign-in** with GitHub and Google, switched on when the provider's `*_CLIENT_ID` /
  `*_CLIENT_SECRET` pair is present. Register `${API_URL}/api/auth/callback/github` and
  `/callback/google` with the providers.
- **Two-factor** (TOTP + backup codes) and **passkeys** (WebAuthn, `rpID` derived from `WEB_URL`),
  managed from `/app/settings/security`. **Sessions** are listed and revoked from
  `/app/settings/sessions`.
- **Rate limits.** Better Auth's own per-IP limits on `/api/auth/*` in production, plus an
  in-process limiter on `/rpc/*` and `/api/v1/*` (`apps/api/src/middleware/rate-limit.ts`). Both
  trust `x-forwarded-for` only as a single value, which is what Caddy produces.

Routes in the app: `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/verify-email`,
`/two-factor`, and `/app/settings` (profile, email, password, delete account).

## Email: templates and language

Every email the kit sends is a template in `packages/email/src/templates.ts`, written in each
language the app has: English and German (`EMAIL_LOCALES`, the locales of
`apps/web/project.inlang/settings.json`; a test keeps the two equal). A template takes its values,
then the recipient's locale, and falls back to `DEFAULT_EMAIL_LOCALE`, English, without one:

```ts
await email.send({ to: user.email, ...templates.resetPassword({ name, url }, 'de') });
```

The locale is that of the request the email answers. The web app's auth client sends the language
the app is showing as `Accept-Language` on every auth call (the `locale` option of
`createAuthClient`, which `apps/web/src/lib/auth.ts` sets to Paraglide's `getLocale`), and each
email callback in `packages/auth/src/server.ts` passes `localeOf(request)` to its template. So
someone using the app in German gets the verification, password reset, email change and account
deletion emails in German, whatever their browser prefers. One email follows the browser instead:
the verification of a new address, which Better Auth sends when the approval link of an email
change is opened, a request the browser makes outside the app. Any other client's
`Accept-Language` is read the same way: its best entry that the kit writes email in, otherwise
English. The contact form's message to `CONTACT_EMAIL` is always in English, because the operator
reads it.

No language is stored per account. An email that no request of the user's causes, such as a
digest sent on a schedule, has no language to follow: a product that sends one stores the user's
choice itself and passes it to the template.

### Adding a template

A product's templates go in `packages/email/src/product.ts`, a file kit releases never change (see
[Where your code goes](/guides/product-files/)). Build each one with `defineTemplate` from
`./render`. It takes the copy in every locale of `EMAIL_LOCALES`, so a missing translation fails
`bun run check`, and the `html` tag escapes every value the copy interpolates, so a name a user
typed stays text. The German copy uses the informal "du", like the app's messages.

```ts
// packages/email/src/product.ts
import { defineTemplate, html } from './render';

type Export = { name: string; url: string };

export const productTemplates = {
	exportReady: defineTemplate<Export>({
		en: ({ name, url }) => ({
			subject: 'Your export is ready',
			title: html`Your export is ready`,
			body: html`<p>Hi ${name},</p><p><a href="${url}">Download it</a>.</p>`,
			text: `Hi ${name},\n\nDownload your export: ${url}`,
		}),
		de: ({ name, url }) => ({
			subject: 'Dein Export ist fertig',
			title: html`Dein Export ist fertig`,
			body: html`<p>Hallo ${name},</p><p><a href="${url}">Lade ihn herunter</a>.</p>`,
			text: `Hallo ${name},\n\nLade deinen Export herunter: ${url}`,
		}),
	}),
};
```

`templates` from `@repo/email` holds yours next to the kit's, and a name the kit already uses stops
the API at start-up. In a procedure, `localeOf(context.headers)` reads the caller's
`Accept-Language`. The web app's API client leaves that header to the browser, so it is the
browser's preference rather than the language chosen in the app:

```ts
await email.send({ to, ...templates.exportReady({ name, url }, localeOf(context.headers)) });
```

## Cookie on the web, bearer token in the shells

Auth depends on the transport, not the platform:

- **Browsers** use an httpOnly session cookie. During server-side rendering `hooks.server.ts`
  rewrites API calls to the internal `API_URL` and forwards the browser's cookies.
- **Tauri shells** (the static build) have no first-party cookies for their origin, so they use a
  bearer token from Better Auth's `bearer` plugin. The API returns it in the `set-auth-token`
  header. The client stores it and sends `Authorization: Bearer …` on every request.

The switch happens at build time (`ADAPTER=static`). The UI code is identical. If web and API live
on sibling subdomains, set `COOKIE_DOMAIN` (e.g. `.example.com`) so the cookie spans them. A
single-origin deployment does not need it.

The session cookie is `SameSite=Lax`, so a page on another site cannot make a browser send it with
a write. A page on a sibling subdomain can, because it is the same site, so the API also refuses
forged requests itself: every `/rpc` call must carry the `x-csrf-token` header that
`@repo/api-client` adds and an HTML form cannot send, and a write to `/api/v1` that carries a cookie
is refused when it comes from an origin outside `WEB_URL` and `TRUSTED_ORIGINS`. Bearer requests
carry no cookie, so that second check never applies to them. The
[API reference](/reference/api/) has the details.

The shells sign in with email and password only. Social sign-in ends with a session cookie in the
system browser, which the shell never sees; WebAuthn refuses a passkey made for `WEB_URL`'s hostname
on the shell's `tauri://localhost` or `http://tauri.localhost` page; and the second step of a
two-factor sign-in waits in a cookie that a cross-site page never gets back. So inside a shell the
app hides social sign-in and passkeys, and its code page says it cannot finish a two-factor sign-in
(`SOCIAL_SIGN_IN_AVAILABLE`, `PASSKEYS_AVAILABLE` and `TWO_FACTOR_SIGN_IN_AVAILABLE` in
`apps/web/src/lib/api.ts`); the same static build served from a static host keeps all three.
Passkeys added in a browser can still be renamed or removed from the shell. For the same cookie
reason an admin could start impersonating a user in a shell but never stop, so the shell's admin
panel leaves impersonation to the web app (`IMPERSONATION_AVAILABLE`). Links the shell puts in
an email go to `PUBLIC_WEB_URL` through `returnUrl()`. `apps/native/README.md` lists what else the
shells lack.

## The session guard is a universal `load`

Protected routes redirect *before* rendering. The static SPA has no server, so
`apps/web/src/routes/(app)/app/+layout.ts` is a **universal** `load`: it asks the API for the
session and throws `redirect(303, '/login?next=…')` when there is none. During SSR it runs on the
server (a real 303, cookies forwarded). In the SPA it runs in the browser with the bearer token.
`/login` and `/signup` use the same trick in reverse (signed in → `/app`).

The guard tells *signed out* from *unreachable*. Better Auth answers a missing or expired session
with a 4xx, and only that counts as signed out. A 5xx, or a fetch that threw, makes `/app` and
`/admin` answer **503** with an outage page instead.

## The UI discovers auth capabilities from the API

The sign-in page needs to know which social providers are configured and whether sign-up ends in
"check your inbox". The API exposes a public procedure, `system.authConfig`
(`GET /api/v1/auth-config`), returning `{ socialProviders, requireEmailVerification }` computed
from the same environment that configures Better Auth. Adding a provider is one env pair on the
server, with no frontend redeploy.

## Changing auth plugins

Auth plugins own their tables, and the Better Auth CLI generates `packages/db/src/schema/auth.ts`
from the auth config. After adding, changing or removing a plugin, regenerate it:

```sh
bun run auth:schema
```

The file also carries a constraint the app relies on that the CLI does not generate: a unique
index on `passkey.credential_id`.

Every regeneration drops these hand-added constraints, so `auth:schema` checks the file right after
the CLI writes it and **fails until each one is back**, naming what is missing and the code that
restores it. The failure is deliberate: a migration generated from the file as the CLI left it
would drop them from your database. Do not chain `auth:schema` with the migration. Instead:

1. Run `git diff packages/db/src/schema/auth.ts` to see what the generator removed. Put back the
   header comment and the lines the check named, and keep what the CLI changed for your config.
2. Run `bun packages/db/src/schema/auth-constraints.ts` to check again without regenerating
   (`auth:schema` would overwrite your fix).
3. Run `bun run db:kit-drift`. The auth tables belong to the kit's migration history, which
   `db:generate` never writes, so the change goes into a migration of yours: this prints the SQL
   your config needs that none of your migrations holds yet. It must not drop an index or a
   constraint on the tables above. If it does, one is still missing: put it back and run it again.
4. Run `bun run db:generate --custom --name=<name>`, put that SQL in the file it creates in
   `packages/db/drizzle-product/`, and run `bun run db:migrate`. `bun run db:kit-drift` now finds
   nothing left to add, and `bun run test`, which fails until then, passes again.

A field of your own on the user does not have to change a kit table at all. A table of yours keyed
by the user's id, such as `user_profile (user_id primary key references "user")`, exported from
`packages/db/src/schema/product.ts`, gets its migration from a plain `bun run db:generate`, and
kit releases never touch it.

If you removed a plugin, the check reports its table as missing. Delete that table's entries from
`HAND_ADDED_AUTH_CONSTRAINTS` in `packages/db/src/schema/auth-constraints.ts` and from the header
of `auth.ts`, then check again.

`bun run test` runs the same check, so CI and the pre-push hook fail on a regenerated `auth.ts`
committed without them. Apart from those lines, the generated files (`auth.ts`,
`packages/db/drizzle/` and `packages/db/drizzle-product/meta/`) are regenerated, never edited.

`auth:schema` runs the Better Auth CLI **pinned to the version of the `better-auth` dependency**
(`auth@1.7.7`), not `@latest`. Bump the two together, or the schema it generates stops matching the
runtime that reads it.

## Security notes

- Emailed links (verify, reset, change-email, delete) hit the API and redirect back to the app with
  `?token=` or `?error=`. In development they are printed to the API terminal.
- Better Auth's Scalar reference (`/api/auth/reference`) and its generated schema
  (`/api/auth/open-api/generate-schema`) are **404 in production**. Both are unauthenticated and
  outside the API's own limiter. Both work in development.
- Platform administrators can ban users with a reason and an expiry, and revoke their sessions
  (see [Admin](/guides/admin/)).
