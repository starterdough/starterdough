import { authFor } from '#lib/auth.js';
import type { PageLoad } from './$types';

/**
 * How many passkeys the account has, for the getting-started checklist. Loaded here, as the
 * security settings page loads its list, because the Better Auth store does not resolve during
 * SSR. `null` on failure: the step then goes by two-factor authentication alone rather than failing
 * the page.
 */
function passkeyCount(fetch: Parameters<typeof authFor>[0]): Promise<number | null> {
	return authFor(fetch)
		.passkey.listUserPasskeys()
		.then((result) => result.data?.length ?? null)
		.catch(() => null);
}

export const load: PageLoad = async ({ fetch }) => ({ passkeys: await passkeyCount(fetch) });
