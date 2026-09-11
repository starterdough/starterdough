---
title: Authentication
description: Better Auth inside the API; cookies on the web, bearer tokens in the shells; email flows, social sign-in, two-factor, passkeys and sessions.
---

Better Auth runs **inside the API** (`packages/auth/src/server.ts`, mounted at `/api/auth/*`). The
frontends only ever use the client factory from `@repo/auth/client`; they never import the server
instance or the database.

## What ships

- **Email + password** with verification (`REQUIRE_EMAIL_VERIFICATION`, default on in production),
  password reset, change email (confirmed from the old address) and delete account (confirmed by
  email). Every email goes through `packages/email`: printed to the API console in development,
  sent with Resend when `RESEND_API_KEY` is set — which production **requires**, together with an
  `EMAIL_FROM` on a domain a provider will accept. Without them the API refuses to boot rather than
  fall back to a console provider nobody reads (see [Configuration](/start/configuration/)).
- **Social sign-in** with GitHub and Google, switched on when the provider's `*_CLIENT_ID` /
  `*_CLIENT_SECRET` pair is present. Register `${API_URL}/api/auth/callback/github` and
  `/callback/google` with the providers.
- **Two-factor** (TOTP + backup codes) and **passkeys** (WebAuthn, `rpID` derived from `WEB_URL`),
  managed from `/app/settings/security`. **Sessions** are listed and revoked from
  `/app/settings/sessions`.
- **Rate limits.** Better Auth's own per-IP limits on `/api/auth/*` in production, plus an
  in-process limiter on `/rpc/*` and `/api/v1/*` (`apps/api/src/middleware/rate-limit.ts`). Both
  trust `x-forwarded-for` only as a single value — what Caddy produces.

Routes in the app: `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/verify-email`,
`/two-factor`, and `/app/settings` (profile, email, password, delete account).

## Cookie on the web, bearer token in the shells

Auth is transport-aware, not platform-aware:

- **Browsers** use an httpOnly session cookie. During server-side rendering `hooks.server.ts`
  rewrites API calls to the internal `API_URL` and forwards the browser's cookies.
- **Tauri shells** (the static build) have no first-party cookies for their origin, so they use a
  bearer token from Better Auth's `bearer` plugin: the API returns it in the `set-auth-token`
  header, the client stores it and sends `Authorization: Bearer …` on every request.

The switch happens at build time (`ADAPTER=static`); the UI code is identical. If web and API live
on sibling subdomains, set `COOKIE_DOMAIN` (e.g. `.example.com`) so the cookie spans them; a
single-origin deployment avoids the question entirely.

## The session guard is a universal `load`

Protected routes redirect *before* rendering, server-side when there is a server — and the static
SPA has no server. So `apps/web/src/routes/(app)/app/+layout.ts` is a **universal** `load`: it
asks the API for the session and throws `redirect(303, '/login?next=…')` when there is none.
During SSR it runs on the server (a real 303, cookies forwarded); in the SPA it runs in the browser
with the bearer token. `/login` and `/signup` use the same trick in reverse (signed in → `/app`).

It tells *signed out* from *unreachable*. Better Auth answers a missing or expired session with a
4xx, and only that counts as signed out; a 5xx, or a fetch that threw, makes `/app` and `/admin`
answer **503** with an outage page instead. Redirecting to `/login` — which is what used to happen —
told a signed-in user their session had ended every time the API blipped.

## The UI discovers auth capabilities from the API

The sign-in page needs to know which social providers are configured and whether sign-up ends in
"check your inbox". Instead of mirroring that into the frontend's environment, the API exposes a
public procedure, `system.authConfig` (`GET /api/v1/auth-config`), returning
`{ socialProviders, requireEmailVerification }` computed from the same environment that configures
Better Auth. Adding a provider is one env pair on the server — no frontend redeploy.

## Changing auth plugins

Auth plugins own their tables. After adding or changing one:

```sh
bun run auth:schema && bun run db:generate && bun run db:migrate
```

Generated files
(`packages/db/src/schema/auth.ts`, `packages/db/drizzle/`) are regenerated, never edited.

`auth:schema` runs the Better Auth CLI **pinned to the version of the `better-auth` dependency**
(`auth@1.7.3`), not `@latest`: bump the two together, or the schema it generates stops matching the
runtime that reads it.

## Security notes

- Emailed links (verify, reset, change-email, delete) hit the API and redirect back to the app with
  `?token=` or `?error=`; in development they are printed to the API terminal.
- Better Auth's Scalar reference (`/api/auth/reference`) and its generated schema
  (`/api/auth/open-api/generate-schema`) are **404 in production**: 227 KB of interactive HTML and a
  freshly generated 187 KB document per request, unauthenticated and outside the API's own limiter,
  are not something to serve to the internet. Both work in development.
- Platform administrators can ban users with a reason and an expiry, and revoke their sessions
  (see [Admin](/guides/admin/)).
