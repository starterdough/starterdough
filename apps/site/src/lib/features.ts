/**
 * The feature list shared by the landing page (short) and `/features` (long). Every statement
 * must match the repository README and `docs/DECISIONS.md`.
 */
export interface Feature {
	id: string;
	title: string;
	summary: string;
	details: string[];
	/** Where the feature lives, for the curious. */
	code?: string;
}

export const features: Feature[] = [
	{
		id: 'auth',
		title: 'Authentication',
		summary:
			'Email and password with verification, password reset, change email, delete account. GitHub and Google switch on when their credentials are present. Two-factor, passkeys, session management and rate limits included.',
		details: [
			'Email + password with verification (default on in production), password reset, change email confirmed from the old address, delete account confirmed by email. Every email goes through one provider abstraction: console in development, Resend when a key is set.',
			'Social sign-in with GitHub and Google is enabled by setting the client id and secret. The sign-in page asks the API which providers are live, so there is no second configuration in the frontend.',
			'Two-factor authentication (TOTP + backup codes) and passkeys (WebAuthn), managed from the security settings. Users can list and revoke their sessions.',
			'Rate limits on the auth routes and on every procedure. The client address comes from a single forwarded IP, which is what Caddy sends.',
			'Browsers use an httpOnly cookie. The native shells use a bearer token. The UI code is identical.',
		],
		code: 'packages/auth · apps/web/src/routes/(auth)',
	},
	{
		id: 'admin',
		title: 'Admin surface',
		summary:
			'Platform administrators search, ban and impersonate users, manage feature flags and check system health.',
		details: [
			'A platform administrator is a user with the admin role. The first one is created from the command line; further admins are promoted in the UI.',
			'Users: search, ban and unban with reason and expiry, set role, revoke sessions, impersonate for one hour with a visible banner and a way back.',
			'Feature flags with a global default; clients read the resolved map from one endpoint. A system page reports version, uptime, counts, database and migration state, and which optional subsystems are configured.',
		],
		code: 'apps/web/src/routes/(admin) · apps/api/src/rpc/admin.ts',
	},
	{
		id: 'frontend',
		title: 'Frontend platform',
		summary:
			'shadcn-svelte components in a shared package, forms in SPA mode with Zod 4, TanStack Query derived from the API contract, command palette, toasts, skeletons and error boundaries. Dark mode follows the OS.',
		details: [
			'Hand-written primitives plus shadcn-svelte components generated into one shared package, so every surface imports one copy. Design tokens are light-dark() pairs: the page follows the OS with no JavaScript, and the app adds a Light/Dark/System toggle.',
			'Forms use sveltekit-superforms in SPA mode with Zod 4. There are no form actions, because the API is the backend on every target. Schemas come from the contract where a procedure exists.',
			'Data fetching with TanStack Query over the contract: keys, fetchers and types derive from the procedures; mutations invalidate exactly what they changed.',
			'App shell with skip link, responsive sidebar, command palette (Ctrl/⌘K), toasts after mutations, dialog confirmations for destructive actions, skeletons and empty states, error boundaries with a reference id. Optional Sentry and PostHog behind env switches; PostHog loads only after consent.',
			'Accessibility is tested: axe (WCAG 2.2 AA) runs on the public pages in the end-to-end suite.',
		],
		code: 'packages/ui · apps/web/src/lib',
	},
	{
		id: 'i18n',
		title: 'Internationalization',
		summary:
			'Paraglide JS with messages per locale. English and German ship. The locale comes from a cookie, then Accept-Language, then English; users switch it in Settings.',
		details: [
			'Messages live in apps/web/messages/{en,de}/*.json, one file per area of the app, and are compiled by Paraglide JS as part of the check and build steps.',
			'Locale resolution: a cookie set by the switcher in Settings, then the browser’s Accept-Language, then English. No URL prefixes, so the same build works as a static SPA.',
		],
		code: 'apps/web/messages · apps/web/project.inlang',
	},
	{
		id: 'pwa',
		title: 'PWA and offline',
		summary:
			'Web manifest, an install button when the browser offers it, and a service worker that precaches the build and serves a prerendered offline page. Registered in production browsers only.',
		details: [
			'The same URL serves the website, the installable PWA and the native shell’s remote-URL mode.',
			'The service worker precaches the build, tries the network first and falls back to a prerendered offline page for navigations without a connection. It is never registered in development or inside the Tauri shells.',
		],
		code: 'apps/web/src/service-worker.ts · apps/web/src/lib/pwa.svelte.ts',
	},
	{
		id: 'native',
		title: 'Desktop and mobile shells',
		summary:
			'Tauri 2 shells for Windows, macOS, Linux, Android and iOS around the same static build. No IPC: the shell talks to the API over HTTPS with a bearer token, exactly like the browser.',
		details: [
			'The Rust side is a small shell that opens a system webview on the SvelteKit static build. There are no Tauri commands and no per-platform data layer; native capabilities the web lacks are added as Tauri plugins.',
			'Two distribution modes per platform: bundle the static build, or point the shell at the hosted app URL and ship the frontend by deploying the web app.',
			'Auth switches to bearer tokens automatically in the static build, because a webview has no first-party cookies for the app origin.',
		],
		code: 'apps/native',
	},
	{
		id: 'self-host',
		title: 'Self-hosting',
		summary:
			'Docker Compose with Postgres, the API, the web app and Caddy. Two Caddy modes (public subdomains or a single origin) and Tailscale for access from anywhere with no open ports.',
		details: [
			'One compose file runs the whole stack on a VPS or a home server. Caddy in subdomains mode gives app., api. and docs. under your domain with automatic HTTPS; single-origin mode routes by path for tailnet or LAN use.',
			'Tailscale on the host: `tailscale serve` exposes the stack to your devices, `tailscale funnel` makes the same URL public. No open ports, no DNS to manage, and TLS is handled.',
			'The public sites are static and deploy to Cloudflare Workers static assets or to Caddy; the web app builds for Node, Cloudflare Workers or as a static SPA with one environment variable.',
		],
		code: 'infra/compose.yml · infra/caddy',
	},
];
