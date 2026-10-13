import type { FetchLike } from '@repo/api-client';
import { createAuthClient } from '@repo/auth/client';
import { goto } from '$app/navigation';
import { API_URL } from './api';
import { getLocale } from './paraglide/runtime';
import { tokenStore, usesBearerAuth } from './token-store';

const store = usesBearerAuth ? tokenStore : undefined;

/**
 * Auth client (Better Auth, Svelte flavour). Sessions are cookies in the browser and
 * bearer tokens inside the Tauri shells; the switch is a build-time constant.
 */
export const authClient = createAuthClient({
	baseURL: API_URL,
	tokenStore: store,
	// The emails an auth call sends are written in the language the app is showing.
	locale: getLocale,
	// Password accepted but the account has 2FA: collect the code, keeping `?next=`.
	onTwoFactorRedirect: () => goto(`/two-factor${location.search}`),
});

/**
 * Per-request client for `load` functions. Passing SvelteKit's `fetch` lets SSR forward
 * the browser's cookies (see hooks.server.ts); in the browser it is plain `fetch`.
 */
export function authFor(fetch: FetchLike) {
	return createAuthClient({ baseURL: API_URL, tokenStore: store, fetch, locale: getLocale });
}
