import { passkeyClient } from '@better-auth/passkey/client';
import { adminClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient as createBetterAuthClient } from 'better-auth/svelte';

/** Where to keep the bearer token in cookie-less environments (Tauri, mobile, CLI). */
export interface TokenStore {
	get(): string | null | Promise<string | null>;
	set(token: string): void | Promise<void>;
	clear(): void | Promise<void>;
}

export interface AuthClientOptions {
	/** API origin, e.g. `https://api.example.com`. Auth routes live under `/api/auth`. */
	baseURL: string;
	/**
	 * Provide a store to switch from cookies to bearer tokens. Browsers on the same
	 * site should leave this undefined and rely on the httpOnly session cookie.
	 */
	tokenStore?: TokenStore;
	/** Custom fetch (e.g. SvelteKit's `fetch` during SSR). */
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	/**
	 * Called when a sign-in succeeded with the password but the account has two-factor
	 * enabled: navigate to the page that collects the TOTP / backup code.
	 */
	onTwoFactorRedirect?: () => void | Promise<void>;
}

/**
 * Svelte-flavoured Better Auth client with the same plugins as the server:
 * admin, two-factor and passkeys.
 */
export function createAuthClient({
	baseURL,
	tokenStore,
	fetch,
	onTwoFactorRedirect,
}: AuthClientOptions) {
	return createBetterAuthClient({
		baseURL,
		basePath: '/api/auth',
		plugins: [adminClient(), twoFactorClient({ onTwoFactorRedirect }), passkeyClient()],
		fetchOptions: {
			credentials: 'include',
			customFetchImpl: fetch,
			auth: tokenStore
				? {
						type: 'Bearer',
						token: async () => (await tokenStore.get()) ?? '',
					}
				: undefined,
			onSuccess: async (ctx) => {
				// The `bearer` server plugin returns the session token here after sign-in/up and on
				// every session-mutating call (set-active, 2FA…). Cookie clients must not even read it:
				// during SSR, SvelteKit's proxied Response throws on non-allow-listed headers that carry
				// a value, and allow-listing it would inline the session token into the HTML.
				if (!tokenStore) return;
				const token = ctx.response.headers.get('set-auth-token');
				if (token) await tokenStore.set(token);
			},
		},
	});
}

export type AuthClient = ReturnType<typeof createAuthClient>;
