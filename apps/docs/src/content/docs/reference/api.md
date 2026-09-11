---
title: "API: RPC and REST"
description: One router, two transports — the typed oRPC client at /rpc and plain REST under /api/v1 with an OpenAPI 3.1 document. Every procedure, its REST route and its errors.
---

Every client — web, desktop, mobile, scripts — uses the **same HTTP API**
(`apps/api`, Hono on Bun). Procedures are declared **contract-first** in `packages/api-contract`
(oRPC + Zod) and implemented once in `apps/api/src/rpc/`. The same router is exposed over two
transports.

| Path | Purpose |
| --- | --- |
| `GET /healthz` | Liveness: the process answers HTTP. For restarts (the compose healthcheck) |
| `GET /readyz` | Readiness: the database answers too, within 2 s. For routing traffic (Caddy, a load balancer). `503` while Postgres is unreachable — it flaps on purpose, so nothing restarts the API over it |
| `POST /rpc/*` | **oRPC transport** used by the TypeScript clients (`@repo/api-client`) — rich types, dates stay dates |
| `/api/v1/*` | The **same procedures as plain REST** — for Python, `curl` and third parties |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 document generated from the contract. Built once per process and served with an `ETag` and `Cache-Control: no-cache`, so a conditional request (`If-None-Match`) answers `304` |
| `/api/auth/*` | Better Auth — sign-in, sessions, passkeys, two-factor, admin |

The [interactive reference](/reference/api-reference/) renders the OpenAPI document with Scalar.

## RPC: the typed client

```ts
import { createApiClient } from '@repo/api-client';

const api = createApiClient({ baseUrl: 'http://localhost:3000' });
const me = await api.account.me();
```

- `baseUrl` is the API origin; the link POSTs to `${baseUrl}/rpc/<path>`.
- **Browsers** send the session cookie (`credentials: 'include'`). In SvelteKit `load` functions pass
  SvelteKit's `fetch` so server-side rendering forwards the browser's cookies.
- **Cookie-less clients** (Tauri shells, CLIs) pass `getToken` and the client adds
  `Authorization: Bearer …`.
 - Errors are typed: `safe()` and `isDefinedError()` from `@repo/api-client` narrow to the codes a
   procedure declares (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `PRECONDITION_FAILED`, …).

In the app, `$lib/api.ts` exports a ready client (`api`, `apiFor(fetch)`) and `$lib/query.ts`
derives TanStack Query options from the same contract.

## REST: the same procedures over HTTP

Every procedure has a `route` in the contract, so it is also a plain endpoint. Examples:

```sh
curl "$API_URL/api/v1/health"
curl "$API_URL/api/v1/auth-config"
curl -H "Authorization: Bearer $TOKEN" "$API_URL/api/v1/me"
curl -H "Authorization: Bearer $TOKEN" "$API_URL/api/v1/flags"
```

Authenticate with the session cookie or with `Authorization: Bearer <token>`.

`bun run api:openapi` writes `apps/api/openapi.json` for generating clients in other languages. Its
`info.version`, `GET /api/v1/health`, `/admin/system` and the telemetry resource all read the
version from the **root** `package.json` — workspace packages are unversioned — so no artefact can
disagree with the changelog.

## Procedures

**This table is derived from the contract** (`packages/api-contract/src/index.ts`) — one entry per
procedure, all nine of them, with the `route` each one declares. When you add or change a
procedure, change it here too, and regenerate the machine-readable copy with `bun run api:openapi`
(the [interactive reference](/reference/api-reference/) reads the live document and never goes
stale).

All REST paths below are relative to `/api/v1`.

### System and public

| Procedure | REST | Access | Declared errors |
| --- | --- | --- | --- |
| `system.health` | `GET /health` | public | — |
| `system.authConfig` | `GET /auth-config` | public — `{ socialProviders, requireEmailVerification }` | — |
| `contact.send` | `POST /contact` | public, rate-limited — the marketing site's contact form | `PRECONDITION_FAILED` (no email provider or no `CONTACT_EMAIL`) |
| `account.me` | `GET /me` | signed in | `UNAUTHORIZED`, `FORBIDDEN` |
| `system.flags` | `GET /flags` | signed in — every flag at its global default | `UNAUTHORIZED`, `FORBIDDEN` |

### Platform admin

`role = admin` on the *user* (Better Auth's admin plugin). A signed-in non-admin gets `FORBIDDEN`.

| Procedure | REST | Declared errors |
| --- | --- | --- |
| `admin.flags.list` | `GET /admin/flags` | `UNAUTHORIZED`, `FORBIDDEN` |
| `admin.flags.upsert` | `PUT /admin/flags/{key}` | `UNAUTHORIZED`, `FORBIDDEN` |
| `admin.flags.delete` | `DELETE /admin/flags/{key}` | `NOT_FOUND` |
| `admin.system.status` | `GET /admin/system` — version, uptime, counts, database and migrations, configuration | `UNAUTHORIZED`, `FORBIDDEN` |

Sessions, passkeys, two-factor and the admin plugin's user operations are **Better Auth endpoints**
under `/api/auth/*`, not procedures — they are documented by Better Auth's own OpenAPI plugin and
are not in `/api/v1/openapi.json`.

## Errors

Both transports answer JSON with `code`, `message` and, for the codes that declare one, `data`.
Every procedure can answer the two codes its base builder declares (`UNAUTHORIZED` 401,
`FORBIDDEN` 403) unless it is public; the table above lists what each one adds.

| Code | HTTP | `data` | When |
| --- | --- | --- | --- |
| `BAD_REQUEST` | 400 | `{ issues: [{ path, message }] }` | Input failed the contract's Zod schema. Also any free-text field carrying control characters — the issue then names `params.reason = "control_characters"`. Single-line: a flag's `description`, the contact form's name; the contact message keeps tab, LF and CR. One rule instead of sanitising at every sink: a newline in a name reaches an email subject as a second header |
| `UNAUTHORIZED` | 401 | — | No session (or an expired one) |
| `FORBIDDEN` | 403 | — | Signed in, but not permitted / not a platform admin |
| `NOT_FOUND` | 404 | — | No such row |
| `PRECONDITION_FAILED` | 412 | — | The deployment is missing configuration — the contact form has no recipient address |


## Adding a procedure

1. Declare it in `packages/api-contract/src/index.ts` with an explicit `route` (so it is also REST)
   and its `errors`; export the input schema if a form will use it.
 2. Implement it in `apps/api/src/rpc/` — `requireAuth` or `requireAdmin` from `rpc/base.ts` as
    appropriate.
3. Call it from any client: `api.<group>.<name>(input)`. The typed client, the REST endpoint and the
   OpenAPI document update automatically.
4. Add its row to the tables above and run `bun run api:openapi`.

Rules: no endpoint without a contract entry; forms validate the contract's schema, never a copy;
custom error codes set an explicit HTTP `status` (they default to 500 otherwise).

## Limits and headers

Better Auth rate-limits `/api/auth/*` itself in production. An in-process limiter guards `/rpc/*`
and `/api/v1/*` (300 requests per minute per IP by default) — a guardrail against runaway clients,
not a defence against determined abuse; put that at the edge. Both trust `x-forwarded-for` only as a
single value, which is what Caddy produces. CORS allows the origins in `TRUSTED_ORIGINS` (plus
`WEB_URL`) with credentials, and exposes the `set-auth-token` header for bearer clients. Every
response carries `X-Request-Id` — the client's own if it sent a well-formed one, else a fresh UUID —
and the same id is on the access-log line and on any error line.

The per-IP limiter is **in-process**: it is sized for one API container, and running several
replicas behind Caddy needs a shared store before it means what it says.
