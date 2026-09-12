// @ts-check
import { fileURLToPath } from 'node:url';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

/**
 * Astro loads `.env` into `import.meta.env` for source files, not into `process.env` for this
 * config, so `SITE_URL` is loaded here, anchored to this file rather than the working directory.
 * `process.loadEnvFile` never overwrites a variable that is already set: an explicit environment
 * value (CI, `Dockerfile.static`, the deploy workflow) wins, and `.env.local` (loaded first) wins
 * over `.env`, matching Vite's precedence.
 */
for (const name of ['.env.local', '.env']) {
	try {
		process.loadEnvFile(fileURLToPath(new URL(name, import.meta.url)));
	} catch {
		// Absent (or an old runtime without `loadEnvFile`): the environment is the only source.
	}
}

/** What `astro dev` / `astro check` use when `SITE_URL` is unset; a build refuses to guess. */
const DEV_SITE_URL = 'http://localhost:4321';

/** RFC 2606 reserved domains: what the example files ship, never a real deployment. */
const PLACEHOLDER_HOST = /(^|\.)example\.(com|org|net)$/;

/**
 * `SITE_URL` is baked into every canonical URL, `og:url`, absolute `og:image`, RSS link, sitemap
 * entry and the `robots.txt` `Sitemap:` line. Unset, or left on the example domain, the build
 * would ship a site whose absolute URLs point at somebody else's host. So `astro build` refuses
 * both, as `deploy.yml` does for the same variables. `astro dev` and `astro check` keep the
 * localhost fallback.
 *
 * @returns {import('astro').AstroIntegration}
 */
function requireCanonicalSite() {
	return {
		name: 'require-canonical-site',
		hooks: {
			'astro:config:setup': ({ command, config }) => {
				if (command !== 'build') return;
				const raw = process.env.SITE_URL?.trim();
				if (!raw) {
					throw new Error(
						'SITE_URL is not set. A production build needs this site’s own canonical origin ' +
							'(e.g. SITE_URL=https://acme.com): it is baked into every canonical URL, og:image, ' +
							'RSS link and the sitemap. Copy apps/site/.env.example to apps/site/.env, or set it ' +
							'in the build environment.',
					);
				}
				// Astro validates `site` as a URL before this hook, so parsing cannot fail here.
				if (config.site && PLACEHOLDER_HOST.test(new URL(config.site).hostname)) {
					throw new Error(
						`SITE_URL is still the placeholder ${raw}. Set it to the origin this site is served ` +
							'from before building for production.',
					);
				}
			},
		},
	};
}

// https://astro.build/config
export default defineConfig({
	// Canonical URL, required for sitemaps, RSS and OG tags. Set it per environment.
	site: process.env.SITE_URL?.trim() || DEV_SITE_URL,
	// Fully static: deploy to Cloudflare Workers static assets, Caddy, or any CDN.
	output: 'static',
	// The HTML compressor drops line-break whitespace between text and inline elements ("on<a>"),
	// which the formatter's line wrapping produces constantly. Whitespace is cheap; keep it.
	compressHTML: false,
	integrations: [
		requireCanonicalSite(),
		sitemap({
			// Only HTML pages belong in the sitemap; the generated OG images and feeds do not.
			filter: (page) => !/\/(og\/|rss\.xml|robots\.txt)/.test(page),
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
