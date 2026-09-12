import type { Handle, HandleFetch, HandleServerError, ServerInit } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { dev } from '$app/environment';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { m } from '$lib/paraglide/messages';
import { getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { sessionPayloadWithoutToken } from '$lib/utils/session';

// ── Error tracking ─────────────────────────────────────────────────────────────────────────────

/**
 * Sentry on the server is a deployment option (`SENTRY_DSN`). The SDK is imported only when set,
 * so it never loads otherwise. Node initialises once here; the Cloudflare build initialises per
 * request through `initCloudflareSentryHandle` (Workers have no long-lived process).
 */
type Sentry = typeof import('@sentry/sveltekit');
let sentry: Sentry | null = null;

const sentryOptions = () => ({
	dsn: privateEnv.SENTRY_DSN,
	environment: privateEnv.SENTRY_ENVIRONMENT || (dev ? 'development' : 'production'),
	tracesSampleRate: Number(privateEnv.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
});

export const init: ServerInit = async () => {
	if (!privateEnv.SENTRY_DSN) return;
	sentry = await import('@sentry/sveltekit');
	if (import.meta.env.ADAPTER !== 'cloudflare') sentry.init(sentryOptions());
};

const withSentry: Handle = (input) => {
	if (!sentry) return input.resolve(input.event);
	const handles =
		import.meta.env.ADAPTER === 'cloudflare'
			? [sentry.initCloudflareSentryHandle(sentryOptions()), sentry.sentryHandle()]
			: [sentry.sentryHandle()];
	return sequence(...handles)(input);
};

/** Unexpected errors (not `error(...)` thrown on purpose): report, then hand the page a safe message. */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	const id = crypto.randomUUID();
	if (status !== 404) {
		if (sentry) {
			sentry.captureException(error, { extra: { id, status, message, path: event.url.pathname } });
		} else {
			console.error(error);
		}
	}
	return {
		message: status === 404 ? m.common_error_not_found_title() : m.common_error_generic(),
		id,
	};
};

// ── Requests ───────────────────────────────────────────────────────────────────────────────────

/**
 * Locale per request: cookie → Accept-Language → `en` (project.inlang/paraglide.config.ts). The
 * middleware keeps the locale in AsyncLocalStorage for the duration of `resolve`, so every
 * `m.…()` call in loads and components (and `handleError` above) renders in it. No URL
 * prefixes: the request is passed through unchanged.
 */
const withLocale: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request, locale }) => {
		event.request = request;
		return resolve(event, {
			transformPageChunk: ({ html }) =>
				html.replace('%lang%', locale).replace('%dir%', getTextDirection(locale)),
		});
	});

/**
 * Universal `load` functions call the API during SSR through SvelteKit's `fetch`, which hands
 * back a proxied Response so the body can be inlined for hydration. Reading a header that is
 * not allow-listed here throws, and Better Auth and oRPC both read `content-type` on every
 * response. Allow-list it once instead of wrapping every client.
 */
const serializedHeaders: Handle = ({ event, resolve }) =>
	resolve(event, {
		filterSerializedResponseHeaders: (name) => name === 'content-type',
	});

/**
 * Per-document response headers. Caddy's `(security)` snippet already sets HSTS, nosniff, frame,
 * referrer and permissions policy for every surface behind it; these two it does not:
 *
 *  - COOP severs the opener relationship, so a window that opened this page (or that this page
 *    opened) on another origin cannot reach the document.
 *  - `/app` and `/admin` render one signed-in user's data. `private, no-store` keeps it out of
 *    shared caches, the browser's disk cache and the back/forward store, the same reason the
 *    service worker does not cache navigations. `/uploads/*` needs the same header from the
 *    API (@repo/api serves it, not this app).
 */
const securityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('cross-origin-opener-policy', 'same-origin');
	if (/^\/(app|admin)(\/|$)/.test(event.url.pathname)) {
		response.headers.set('cache-control', 'private, no-store');
	}
	return response;
};

export const handle = sequence(withSentry, withLocale, serializedHeaders, securityHeaders);

/**
 * Server-side `fetch` (in `load` functions) → API:
 *  1. rewrite the public API origin to the internal one when API_URL is set
 *     (e.g. http://api:3000 inside Docker Compose, or a tailnet address);
 *  2. forward the browser's cookies so the API sees the session during SSR;
 *  3. strip `token` out of the two auth responses that carry one, because SvelteKit inlines every
 *     response an SSR `load` fetched into the HTML for hydration (see `sessionPayloadWithoutToken`).
 *     Better Auth's bearer plugin accepts that value as a credential for the life of the session,
 *     so an inlined one is a working credential in the page source: `/get-session` carries the
 *     current session's, `/list-sessions` one per device. A `load` that strips them from what it
 *     *returns* does not close this: the raw body is recorded separately, the moment it is read.
 */
export const handleFetch: HandleFetch = async ({ event, request, fetch }) => {
	const publicOrigin = (publicEnv.PUBLIC_API_URL || 'http://localhost:3000').replace(/\/+$/, '');
	const internalOrigin = (privateEnv.API_URL || publicOrigin).replace(/\/+$/, '');

	if (request.url.startsWith(`${publicOrigin}/`) || request.url.startsWith(`${internalOrigin}/`)) {
		const url = request.url.startsWith(`${publicOrigin}/`)
			? `${internalOrigin}${request.url.slice(publicOrigin.length)}`
			: request.url;

		const forwarded = new Request(url, request);
		const cookie = event.request.headers.get('cookie');
		if (cookie) forwarded.headers.set('cookie', cookie);
		const response = await fetch(forwarded);
		const path = new URL(url).pathname;
		if (path.endsWith('/get-session')) return rebuilt(response, sessionPayloadWithoutToken);
		if (path.endsWith('/list-sessions')) return rebuilt(response, withoutTokens);
		return response;
	}

	return fetch(request);
};

/**
 * `response` with `transform` applied to its JSON body. Anything that is not a JSON success passes
 * through untouched; neither shape carries a token. Rebuilding rather than mutating is what makes
 * this work: SvelteKit records a `load` fetch's body when the caller reads it, and the caller only
 * ever sees this new response.
 */
async function rebuilt(
	response: Response,
	transform: (payload: unknown) => unknown,
): Promise<Response> {
	if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
		return response;
	}
	const body = await response.text();
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return new Response(body, copyOf(response));
	}
	return new Response(JSON.stringify(transform(payload)), copyOf(response));
}

/**
 * `payload` with every `token` property removed, however deeply nested. `/list-sessions` answers
 * with an array of session rows rather than the single wrapped session `sessionPayloadWithoutToken`
 * knows, and the plugin may nest more later, so this drops the field by name wherever it appears
 * rather than by path.
 */
function withoutTokens(payload: unknown): unknown {
	if (Array.isArray(payload)) return payload.map(withoutTokens);
	if (!payload || typeof payload !== 'object') return payload;
	return Object.fromEntries(
		Object.entries(payload as Record<string, unknown>)
			.filter(([key]) => key !== 'token')
			.map(([key, value]) => [key, withoutTokens(value)]),
	);
}

/** Status and headers of `response`, minus the two that no longer describe the rebuilt body. */
function copyOf(response: Response): ResponseInit {
	const headers = new Headers(response.headers);
	headers.delete('content-length');
	headers.delete('content-encoding');
	return { status: response.status, statusText: response.statusText, headers };
}
