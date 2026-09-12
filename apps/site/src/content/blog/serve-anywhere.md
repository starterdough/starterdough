---
title: "Serve anywhere: web, PWA, desktop, mobile, your own box"
description: One SvelteKit codebase runs as a website, an installable PWA, a Tauri desktop or mobile app, and on a self-hosted server reachable through Tailscale. How the targets fit together.
pubDate: 2026-09-09
author: Starterdough maintainers
tags: [deployment, tauri, pwa, self-hosting]
---

"Serve anywhere" is a promise about the same code. Starterdough's application is one SvelteKit
codebase; what changes per target is how it is built and where it is hosted. This post walks through
each target and the decisions behind it (D3, D9, D10, D11, D12 and D13 in the repository's decision
log).

## The website

`apps/web` builds for Node with `adapter-node`, for Cloudflare Workers with `adapter-cloudflare`,
or as a static SPA with `adapter-static`. One environment variable, `ADAPTER`, selects the target.
The app is a thin client of the API, so every route works both server-rendered and as a single-page
app. There is no server-only code to strip.

The public surfaces (this site and the documentation) are Astro and fully static. They deploy to
Cloudflare Workers static assets or are served by Caddy when self-hosting. Shared design tokens from
the UI package keep them visually consistent with the app. The tokens are `light-dark()` pairs, so
they follow the operating system's color scheme with no JavaScript.

## The mobile site and the PWA

Not every user wants an installer, and phones are the most common "mobile site" client. The app
ships a web manifest, a theme color and installable icons, shows an "Install app" button when the
browser offers it, and registers a service worker in production browsers. The service worker
precaches the build and serves a prerendered offline page when a navigation has no network.

The same URL serves the website, the installable PWA and the native shell's remote-URL mode. The PWA
is the baseline for "I want this on my computer". Native shells are the next step for needs the web
platform cannot meet.

## The desktop app

`apps/native` is a Tauri 2 project. The shell is a small Rust program that opens a system webview on
the static build of the app. There are no Tauri commands and no IPC data layer: the frontend talks
to the API over HTTPS exactly as the browser does. Tauri provides a small binary on the system
webview, installers, and mobile targets from the same project.

Two things change inside the shell, both automatically. Authentication switches from cookies to a
bearer token, because a webview has no first-party cookies for its own origin. And the frontend can
ship either bundled with the installer or as a thin client pointed at the hosted app URL. In the
second mode you update the app by deploying the web app.

With no IPC there is no hot path in the shell, so Rust versus Bun is decided by packaging and the
mobile story, and Tauri wins. Bun runs everything else: the dev server, the builds, the API and the
tooling.

## The mobile app

The same Tauri project produces Android and iOS apps, wrapping the same Svelte UI. A React Native
app would mean a second UI codebase in a different framework, which is at odds with a small team and
with choosing Svelte in the first place. PWA install is the zero-effort path; Tauri mobile is the
store-presence path.

Mobile UX is therefore web UX with responsive design, so the app invests in it: a responsive sidebar
that becomes a sheet on small screens, and the same accessibility checks in both color modes.

## Your own box

Cloudflare hosts the static surfaces and can host the SvelteKit SSR build. The API, the Python
service and Postgres need a long-lived host. That can be a managed container platform or your own
VPS or home server with `infra/compose.yml`: Postgres, API, web, AI service and Caddy in one compose
file.

Caddy runs in one of two modes. **Subdomains** gives you `app.`, `api.` and `docs.` under your
domain with automatic HTTPS; the session cookie spans them through a cookie domain setting.
**Single-origin** routes by path on one host with TLS terminated elsewhere. No CORS, plain same-site
cookies, which is what tailnet and LAN deployments want.

## Reaching it from anywhere, including your phone

Tailscale on the host closes the loop. `tailscale serve` exposes Caddy to the devices on your
tailnet under a MagicDNS HTTPS name; `tailscale funnel` makes the same URL public. No open ports, no
DNS to manage, certificates handled. Install the Tailscale app on the phone once, and the PWA or the
mobile build works on the go against your own server.

## Why it holds together

Each target is cheap because of one decision made earlier: the application has no backend of its
own. It renders, and it calls the API. Once that is true, "where does it run" becomes a build flag
and a hosting choice rather than a rewrite.
