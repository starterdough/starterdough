import { authFor } from '$lib/auth';
import type { PageLoad } from './$types';

/**
 * Seed the passkey list so the first render (SSR included) shows the real keys instead of three
 * skeleton rows: the Better Auth client the page uses cannot resolve during SSR, so the list only
 * arrived a round trip after hydration. The page's own `loadPasskeys()` still refreshes it after
 * every add, rename and removal. A failure falls back to `null`, which leaves the page in the
 * loading state it already starts in and lets the client fetch — not a 500.
 */
export const load: PageLoad = async ({ fetch }) => {
	const passkeys = await authFor(fetch)
		.passkey.listUserPasskeys()
		.then((result) => result.data ?? null)
		.catch(() => null);
	return { passkeys };
};
