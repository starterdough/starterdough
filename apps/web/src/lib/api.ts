import { type ApiClient, createApiClient, type FetchLike } from '@repo/api-client';
import { env } from '$env/dynamic/public';
import { tokenStore, usesBearerAuth } from './token-store';

/**
 * Browser-facing API origin. Must be absolute. For single-origin deployments
 * (Caddy path routing behind Tailscale) point it at the same host as the app.
 */
export const API_URL = env.PUBLIC_API_URL || 'http://localhost:3000';

/**
 * Origin of the deployed web app, for round trips that leave the browser: an OAuth callback, a
 * payment or portal return, an emailed link. Inside the Tauri shells `location.origin` is
 * `http://tauri.localhost`, which nothing outside the webview can resolve, so those builds need
 * `PUBLIC_WEB_URL` to name the real deployment. Empty everywhere else: the app is already there.
 */
const WEB_URL = (env.PUBLIC_WEB_URL || '').replace(/\/+$/, '');

/**
 * False only in a static (bearer) build with no `PUBLIC_WEB_URL`: there is no address a provider
 * could send the user back to, so the flows that depend on one are hidden instead of handing out
 * an unroutable URL. Build-time constant — safe to read during SSR and in markup.
 */
export const RETURN_URLS_AVAILABLE = !usesBearerAuth || WEB_URL !== '';

/** Absolute URL of one of this app's own pages, for a provider to return to. Browser only. */
export function returnUrl(path: string): string {
	return `${(usesBearerAuth && WEB_URL) || location.origin}${path}`;
}

/** Shared client for components and client-side code. */
export const api: ApiClient = createApiClient({
	baseUrl: API_URL,
	getToken: () => tokenStore.get(),
});

/**
 * Per-request client for `load` functions. Passing SvelteKit's `fetch` lets SSR
 * forward the browser's cookies (see hooks.server.ts) and dedupe requests.
 */
export function apiFor(fetch: FetchLike): ApiClient {
	return createApiClient({ baseUrl: API_URL, fetch, getToken: () => tokenStore.get() });
}
