---
title: Why one HTTP API is the whole architecture
description: Every surface in Starterdough (web, desktop, mobile, scripts, the Python service) is a thin client of a single HTTP API. Here is what that rule buys and what it costs.
pubDate: 2026-09-09
author: Starterdough maintainers
tags: [architecture, api]
---

Starterdough has one architectural rule that everything else follows from: **there is a single
source of truth, and it speaks HTTP.** The SvelteKit app, the Tauri desktop and mobile shells, the
dynamic parts of the Astro sites, command-line scripts and the Python service all consume the same
API: the same authentication, the same procedures, the same OpenAPI document. Nothing else has
business logic, and nothing else touches the database.

This post explains the rule, the alternatives, and what it means day to day. The long form is in the
repository's decision log (D5, D16, D18, D19).

## The rule

`apps/api` is a Hono application on Bun. Procedures are declared contract-first in
`packages/api-contract` with oRPC and Zod, and implemented once in the API. The same router is
exposed over two transports:

- `POST /rpc/*`: the oRPC transport with rich types, used by the TypeScript client in
  `packages/api-client`.
- `/api/v1/*`: plain REST with an OpenAPI 3.1 document at `/api/v1/openapi.json`, used by the
  Python service, `curl` and third parties.

Better Auth is mounted on the same server at `/api/auth/*`. Only the API has a database client.

## The alternatives

**Tauri IPC.** The usual way to build a desktop app with Tauri is to write commands in Rust and call
them from the frontend. That gives the desktop build a data layer the browser build does not have:
two code paths, two sets of bugs. Starterdough's shell has no commands and no `@tauri-apps/api` in
the frontend. It opens a system webview on the static build, and that build uses the same HTTP
client as the browser. The Rust side stays small and only grows for capabilities the web platform
lacks, as Tauri plugins.

**SvelteKit as the backend.** SvelteKit can host server routes and form actions. Using them for
business logic would make the web app a second API and break the static build, because form actions
do not exist without a server. In Starterdough, `apps/web` never imports the database or the auth
server. Server `load` functions call the API with SvelteKit's `fetch`, and a hook rewrites the
origin to the internal API address during server rendering. Server-side rendering is a rendering
concern only.

**tRPC, GraphQL, hand-written REST.** tRPC has no native OpenAPI story, which matters for the
Python side. GraphQL is heavier than the problem. Hand-written REST loses end-to-end types. oRPC
gives typed RPC and REST with OpenAPI from one contract.

## What it buys

**Add a feature once.** Declare the procedure in the contract, implement it in the API, and every
client can call it with full types, one typed method per procedure. The REST endpoint and its
documentation appear without extra work.

**Ship the frontend anywhere.** The frontend holds no business logic, so it builds for Node,
Cloudflare Workers or as a static SPA with one environment variable, and every route works as SSR
and as SPA. That is what makes the native shells cheap: they wrap a build that already exists.

**Auth follows the transport.** Browsers use an httpOnly cookie. The shells, which have no
first-party cookies for their origin, use a bearer token from Better Auth's `bearer` plugin. The UI
code is identical; the transport is chosen at build time.

**The database has exactly one client.** Only the API uses Postgres, through Drizzle on Bun's
native driver. Frontends cannot reach it even by accident, because the server-only packages are
never in their dependency graph.

## Two places where the rule matters

**The session guard.** Protected routes redirect before rendering, server-side when there is a
server. The conventional SvelteKit answer is a server-only layout load. The static build has no
server, so those loads would 404 inside the shell. Starterdough uses a universal load instead: it
asks the API for the session and redirects when there is none. During SSR it runs on the server with
the browser's cookies forwarded; in the SPA it runs in the browser with the bearer token. Same file,
all targets.

**Auth capabilities.** The sign-in page needs to know which social providers are configured and
whether sign-up ends in "check your inbox". That information lives in the API's environment.
Mirroring it into the frontend's environment would be a second source of truth. So the API exposes
a public procedure, `GET /api/v1/auth-config`, computed from the same environment that configures
Better Auth, and the UI renders from it. Adding a provider is one environment pair on the server,
with no frontend redeploy.

## What it costs

Every feature is added in two places: the contract and the implementation. Server rendering makes
one more HTTP hop than a co-located backend would, mitigated by the internal origin. And the API
must run on a long-lived process (a container or a VPS) rather than on Workers, because it holds
database connections. That is the one container host in the design; everything static goes to the
edge.

Those are the costs of having exactly one place where the product's behaviour is defined.
