// @ts-check
import { satteri } from '@astrojs/markdown-satteri';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { loadSiteEnv } from '../../scripts/load-site-env.mjs';

/**
 * Astro loads `.env` into `import.meta.env` for source files, never into `process.env` for this
 * config, so `SITE_URL` and `DOCS_REPO_URL` must be loaded here, anchored to this file.
 * A nonempty explicit environment value (CI, `Dockerfile.static`, the deploy workflow) wins,
 * `.env.local` wins over `.env`, and a blank `SITE_URL` is treated as absent at every layer.
 */
loadSiteEnv(import.meta.url);

/** What `astro dev` / `astro check` use when `SITE_URL` is unset; a build refuses to guess. */
const DEV_SITE_URL = 'http://localhost:4322';

/** RFC 2606 reserved domains: what the example files ship, never a real deployment. */
const PLACEHOLDER_HOST = /(^|\.)example\.(com|org|net)$/;

/**
 * Public repository this copy of the documentation is edited in, if there is one: the header's
 * GitHub link and "Edit this page". Unset (the default) renders neither, so the kit ships no
 * repository URL of its own in a buyer's docs chrome.
 */
const repoUrl = process.env.DOCS_REPO_URL?.trim().replace(/\/+$/, '') || null;

// SITE_URL is the canonical origin. When it carries a path (https://host/docs for the
// single-origin Caddy mode), that path is the base every link and asset is served under.
const site = new URL(process.env.SITE_URL?.trim() || DEV_SITE_URL);
const base = site.pathname.replace(/\/+$/, '') || undefined;

/**
 * `SITE_URL` is baked into every canonical URL and sitemap entry, and its path becomes `base`.
 * An unset value or the example domain would ship docs whose absolute URLs point at another host,
 * so `astro build` refuses both. `astro dev` and `astro check` keep the localhost fallback.
 *
 * @returns {import('astro').AstroIntegration}
 */
function requireCanonicalSite() {
	return {
		name: 'require-canonical-site',
		hooks: {
			'astro:config:setup': ({ command }) => {
				if (command !== 'build') return;
				const raw = process.env.SITE_URL?.trim();
				if (!raw) {
					throw new Error(
						'SITE_URL is not set. A production build needs this site’s own canonical origin ' +
							'(e.g. SITE_URL=https://docs.acme.com, or https://acme.com/docs in the ' +
							'single-origin Caddy mode): it is baked into every canonical URL and sitemap entry, ' +
							'and its path becomes the base every link is served under. Copy ' +
							'apps/docs/.env.example to apps/docs/.env, or set it in the build environment.',
					);
				}
				if (PLACEHOLDER_HOST.test(site.hostname)) {
					throw new Error(
						`SITE_URL is still the placeholder ${raw}. Set it to the origin these docs are served ` +
							'from before building for production.',
					);
				}
			},
		},
	};
}

/**
 * Root-relative links inside the Markdown/MDX content (`[Admin](/guides/admin/)`) are written
 * for the default deployment (docs at `/`). Astro prefixes assets and Starlight its own navigation
 * with `base`, but not the links authors wrote. This Sätteri plugin does, so the same content
 * works under `/docs`. The plugin list is empty when there is no base.
 */
/** @type {NonNullable<import('@astrojs/markdown-satteri').SatteriProcessorOptions['mdastPlugins']>} */
const mdastPlugins = base
	? [
			{
				name: 'base-links',
				link(node) {
					if (
						node.url.startsWith('/') &&
						!node.url.startsWith('//') &&
						node.url !== base &&
						!node.url.startsWith(`${base}/`)
					) {
						return { ...node, url: base + node.url };
					}
				},
			},
		]
	: [];

/** @type {Parameters<typeof starlight>[0]} */
const starlightOptions = {
	title: 'Starterdough',
	description:
		'Documentation for Starterdough, a Bun-native, serve-anywhere SaaS starter: one HTTP API, every surface a thin client.',
	sidebar: [
		{
			label: 'Start',
			items: [
				{ label: 'Quickstart', slug: 'start/quickstart' },
				{ label: 'Configuration', slug: 'start/configuration' },
			],
		},
		{
			label: 'Guides',
			items: [
				{ label: 'Authentication', slug: 'guides/authentication' },
				{ label: 'Admin', slug: 'guides/admin' },
				{ label: 'Worked feature example', slug: 'guides/feature-example' },
				{ label: 'Frontend platform', slug: 'guides/frontend' },
				{ label: 'Serve anywhere', slug: 'guides/serve-anywhere' },
				{ label: 'Operations', slug: 'guides/operations' },
			],
		},
		{
			label: 'Reference',
			items: [
				{ label: 'API: RPC and REST', slug: 'reference/api' },
				{ label: 'API reference (interactive)', link: '/reference/api-reference/' },
				{ label: 'Commands', slug: 'reference/commands' },
				{ label: 'Architecture', slug: 'reference/architecture' },
			],
		},
	],
};

if (repoUrl) {
	starlightOptions.social = [{ icon: 'github', label: 'GitHub', href: repoUrl }];
	starlightOptions.editLink = { baseUrl: `${repoUrl}/edit/main/apps/docs/` };
}

// https://astro.build/config
export default defineConfig({
	site: site.origin,
	...(base ? { base } : {}),
	markdown: { processor: satteri({ mdastPlugins }) },
	integrations: [requireCanonicalSite(), starlight(starlightOptions)],
});
