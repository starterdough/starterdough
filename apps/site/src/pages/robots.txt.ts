import type { APIContext } from 'astro';
import { requireSite } from '../lib/site';

/**
 * Generated at build time so the sitemap URL follows `SITE_URL` instead of being hard-coded in
 * `public/robots.txt`.
 */
export function GET(context: APIContext) {
	const sitemap = new URL('/sitemap-index.xml', requireSite(context.site)).href;
	const body = ['User-agent: *', 'Allow: /', '', `Sitemap: ${sitemap}`, ''].join('\n');
	return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
