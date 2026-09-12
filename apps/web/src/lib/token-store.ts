import type { TokenStore } from '@repo/auth/client';
import { browser } from '$app/environment';

const KEY = 'starterdough.session-token';

/**
 * Static (Tauri) builds have no first-party cookies, so the session travels as a
 * bearer token. Web builds keep this store empty and rely on the httpOnly cookie.
 */
export const usesBearerAuth = import.meta.env.ADAPTER === 'static';

export const tokenStore: TokenStore = {
	get: () => (browser ? localStorage.getItem(KEY) : null),
	set: (token) => {
		if (browser) localStorage.setItem(KEY, token);
	},
	clear: () => {
		if (browser) localStorage.removeItem(KEY);
	},
};
