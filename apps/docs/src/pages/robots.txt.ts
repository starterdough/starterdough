import type { APIContext } from 'astro';

/**
 * Generated rather than a `public/` file so the `Sitemap:` line follows `SITE_URL` and the base
 * (`/docs` in the single-origin Caddy mode, where this file is not at the origin root and the
 * app's own `robots.txt` is what crawlers read).
 */
export function GET(context: APIContext) {
	if (!context.site)
		throw new Error('`site` is unset: astro.config.mjs resolves it from SITE_URL.');
	const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
	const sitemap = new URL(`${base}/sitemap-index.xml`, context.site).href;
	const body = ['User-agent: *', 'Allow: /', '', `Sitemap: ${sitemap}`, ''].join('\n');
	return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
