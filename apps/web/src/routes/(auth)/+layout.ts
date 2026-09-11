import type { AuthConfig } from '@repo/api-client';
import { apiFor } from '$lib/api';
import type { LayoutLoad } from './$types';

/** Shown when the API cannot be reached: no social buttons, no "check your inbox" gate. */
const fallback: AuthConfig = { socialProviders: [], requireEmailVerification: false };

/**
 * Which sign-in methods this deployment offers. Comes from the API so the UI never guesses
 * from its own env, and degrades gracefully so the auth pages still render when it is down.
 */
export const load: LayoutLoad = async ({ fetch }) => {
	const authConfig = await apiFor(fetch)
		.system.authConfig()
		.catch(() => fallback);
	return { authConfig };
};
