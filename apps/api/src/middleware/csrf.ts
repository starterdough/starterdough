/**
 * Cross-site request forgery against `/api/v1/*`, the REST transport. Defence in depth.
 *
 * Better Auth's session cookie is `SameSite=Lax`, so a browser already leaves it off a POST from
 * another site. It still attaches it to one from a sibling subdomain, which is the same site
 * (`blog.example.com` posting to `api.example.com`), and oRPC parses form-encoded and multipart
 * bodies, so a plain HTML form on such a page could call a procedure as whoever is signed in.
 *
 * `/rpc/*` closes this with a header a form cannot send (`rpc/handler.ts`). This transport serves
 * curl, Python services and third parties, which cannot all be asked for one, so it refuses what a
 * forgery looks like instead: a method that changes something, carrying a cookie (which a browser
 * attaches on its own), from a page whose origin is not in `trustedOrigins()`, the list CORS reads.
 * The page is the one `Origin` names, matched exactly; with no `Origin`, a `Sec-Fetch-Site` of
 * `cross-site` or `same-site` is refused outright. Everything else passes untouched: a request
 * without a cookie (a bearer or service token), and one with neither header, which is a server-side
 * caller such as SvelteKit forwarding the cookie during SSR (every current browser sends `Origin`
 * with a POST).
 *
 * Any cookie counts, not just the session cookie: its name changes with `__Secure-` and Better
 * Auth's prefix, impersonation adds a second one, and no first-party page writes from an origin
 * outside the list anyway, because CORS, reading the same list, would not let it.
 */
import { trustedOrigins } from '@repo/env';
import type { MiddlewareHandler } from 'hono';

/** Methods that must not change anything, so a forged one gains an attacker nothing. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True for a cookie-carrying write that a browser sent from a page outside `trusted`. */
export function isCrossSiteCookieWrite(request: Request, trusted: ReadonlySet<string>): boolean {
	if (SAFE_METHODS.has(request.method)) return false;
	if (!request.headers.has('cookie')) return false;
	const origin = request.headers.get('origin');
	// Including `null`, which a sandboxed frame, a `data:` page or a cross-origin redirect sends.
	if (origin !== null) return !trusted.has(origin);
	// No origin to check, but the browser says another page sent it: refuse rather than guess.
	const site = request.headers.get('sec-fetch-site');
	return site === 'cross-site' || site === 'same-site';
}

export interface CrossSiteOptions {
	/** Origins whose pages may write with the cookie. Defaults to `trustedOrigins()`. */
	origins?: readonly string[];
}

/** Answers a forged write with `403 { error: 'forbidden_origin' }`. */
export function refuseCrossSiteCookieWrites(options: CrossSiteOptions = {}): MiddlewareHandler {
	const trusted = new Set(options.origins ?? trustedOrigins());
	return async (c, next) => {
		if (isCrossSiteCookieWrite(c.req.raw, trusted)) {
			return c.json({ error: 'forbidden_origin' }, 403);
		}
		await next();
	};
}
