import { fileURLToPath } from 'node:url';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import cloudflare from '@sveltejs/adapter-cloudflare';
import node from '@sveltejs/adapter-node';
import staticAdapter from '@sveltejs/adapter-static';
import type { KitConfig } from '@sveltejs/kit';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { playwright } from '@vitest/browser-playwright';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * One codebase, three deployment targets (README → "Serve anywhere"):
 *
 *   ADAPTER=node        (default) self-hosted container / VPS, server-rendered
 *   ADAPTER=cloudflare  Cloudflare Workers, server-rendered at the edge
 *   ADAPTER=static      pure SPA bundle for the Tauri desktop/mobile shells and static hosts
 *
 * Every target talks to the same HTTP API (@repo/api) through @repo/api-client.
 */
const target = (process.env.ADAPTER ?? 'node') as 'node' | 'cloudflare' | 'static';

/**
 * Where the static (SPA) build lands. It defaults to `build/`, which the node and Cloudflare
 * adapters also write to, so the Tauri shell, whose `beforeBuildCommand` runs this build, would
 * silently overwrite a server build sitting there (and vice versa). `STATIC_OUT_DIR` gives it a
 * directory of its own; `build:static:desktop` sets it.
 */
const staticOutDir = process.env.STATIC_OUT_DIR || 'build';

const adapter =
	target === 'cloudflare'
		? cloudflare()
		: target === 'static'
			? staticAdapter({ fallback: 'index.html', pages: staticOutDir, assets: staticOutDir })
			: node();

const root = fileURLToPath(new URL('.', import.meta.url));

type CspConfig = NonNullable<KitConfig['csp']>;
/** `self`, a scheme or an origin; SvelteKit adds the quotes where CSP wants them. */
type CspSource = NonNullable<NonNullable<CspConfig['directives']>['connect-src']>[number];

/**
 * Content-Security-Policy for every page this app serves, derived from the same `PUBLIC_*` values
 * the client is built with, the way `apps/native/scripts/tauri-config.ts` derives the shell's
 * policy, so the two cannot disagree. `vite`'s own `loadEnv` is the reader here, which also covers
 * `.env.production` and the process environment.
 *
 * Third-party origins appear only when that integration is switched on:
 *  - `PUBLIC_API_URL`      the API (same origin on a single-origin deployment, where 'self' covers it)
 *  - `PUBLIC_STORAGE_ORIGIN`  the presigned-upload bucket, e.g. https://<bucket>.r2.cloudflarestorage.com.
 *                          Empty means the local storage driver, which lives on the API origin.
 *  - `PUBLIC_SENTRY_DSN`   the SDK posts envelopes to the DSN's host
 *  - `PUBLIC_POSTHOG_KEY`  events go to the PostHog host, lazily loaded bundles to its assets twin
 */
function csp(env: Record<string, string>): CspConfig {
	/** The origin of an absolute URL; a typo in the environment fails the build, not the page. */
	const origin = (value: string, name: string): CspSource => {
		try {
			// A URL origin is a CSP host-source by construction, which the type cannot express.
			return new URL(value).origin as CspSource;
		} catch {
			throw new Error(`${name} is not an absolute URL: ${value}`);
		}
	};

	const connect = new Set<CspSource>([
		'self',
		origin(env.PUBLIC_API_URL || 'http://localhost:3000', 'PUBLIC_API_URL'),
	]);
	const scripts = new Set<CspSource>(['self']);

	if (env.PUBLIC_STORAGE_ORIGIN) {
		connect.add(origin(env.PUBLIC_STORAGE_ORIGIN, 'PUBLIC_STORAGE_ORIGIN'));
	}
	if (env.PUBLIC_SENTRY_DSN) connect.add(origin(env.PUBLIC_SENTRY_DSN, 'PUBLIC_SENTRY_DSN'));
	if (env.PUBLIC_POSTHOG_KEY) {
		const name = 'PUBLIC_POSTHOG_HOST';
		const host = origin(env.PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com', name);
		connect.add(host);
		scripts.add(
			origin(host.replace(/^(https:\/\/\w+)\.i\.posthog\.com$/, '$1-assets.i.posthog.com'), name),
		);
	}

	return {
		// Nonces for server-rendered pages, hashes for prerendered ones: the static (Tauri) build
		// has no server to mint a nonce, and the shell applies its own policy as a header on top.
		mode: 'auto',
		directives: {
			'default-src': ['self'],
			// No 'unsafe-inline': SvelteKit nonces (SSR) or hashes (prerendered) the only inline
			// script left on the page, its own hydration bootstrap. The root layout passes
			// `disableHeadScriptInjection` to `<ModeWatcher>` precisely so that stays true; see the
			// comment there for why a hash cannot cover that script. No external origin, no eval.
			'script-src': [...scripts],
			// Svelte 5 animates through the Web Animations API and injects no rules, but SSR markup
			// and app.html carry `style` attributes, which only 'unsafe-inline' allows. SvelteKit
			// adds no nonce to a directive that already allows inline styles, so it stays effective.
			'style-src': ['self', 'unsafe-inline'],
			'img-src': ['self', 'data:', 'blob:'],
			'connect-src': [...connect],
			'frame-ancestors': ['none'],
			'base-uri': ['self'],
			'form-action': ['self'],
			'object-src': ['none'],
		},
	};
}

export default defineConfig(({ command, mode }) => ({
	define: {
		'import.meta.env.ADAPTER': JSON.stringify(target),
	},
	plugins: [
		// i18n: compiles apps/web/messages/** into $lib/paraglide (strategy etc. live in
		// project.inlang/paraglide.config.ts). One module per locale while developing (few files,
		// fast HMR); one module per message for builds so each route chunk carries only its own text.
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			outputStructure: command === 'serve' ? 'locale-modules' : 'message-modules',
		}),
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
			},
			adapter,
			csp: csp(loadEnv(mode, root, 'PUBLIC_')),
			// Registered by $lib/pwa.svelte.ts instead: production browsers only, never in the
			// Tauri shells (their files ship in the bundle) and never in dev.
			serviceWorker: { register: false },
		}),
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }],
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**'],
				},
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
				},
			},
		],
	},
}));
