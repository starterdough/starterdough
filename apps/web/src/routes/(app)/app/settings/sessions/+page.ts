import { authFor } from '$lib/auth';
import type { PageLoad } from './$types';

/**
 * Seed the device list so the first render (SSR included) shows the real sessions instead of three
 * skeleton rows. "This device" is matched against `data.session.session.id`, which the /app layout
 * load already has — asking for the session again here cost a second `/get-session` per render.
 *
 * Nothing this returns carries `session.token`. Better Auth's bearer plugin accepts that value as a
 * credential for the life of the session (~7 days), so publishing one per device in the HTML would
 * defeat the httpOnly cookie: an XSS that can read the DOM could exfiltrate credentials that
 * survive signing out. A universal `load` has two ways to publish it and it takes both strips:
 *
 *  1. what this function returns — SvelteKit serializes it into the page for hydration, so `token`
 *     is destructured off every row below;
 *  2. the raw response body — SvelteKit *also* inlines every response an SSR `load` fetched, so the
 *     browser's re-run of this load need not repeat the request. That one is invisible from here
 *     and is stripped in `hooks.server.ts`, which already does the same for `/get-session`.
 *
 * (2) is the easy one to miss: doing (1) alone still ships every device's token in the page source,
 * verbatim. Do not remove either.
 *
 * The page's own `load()` still fetches the full rows, tokens included, after hydration — revoking
 * a session needs one, and until it lands the revoke buttons stay disabled. A failure here falls
 * back to `null`, which leaves the page in the loading state it already starts in and lets that
 * client fetch cover it, rather than a 500.
 */
export const load: PageLoad = async ({ fetch }) => {
	const rows = await authFor(fetch)
		.listSessions()
		.then((result) => result.data ?? null)
		.catch(() => null);
	if (!rows) return { sessions: null };
	// Sorted here, once: the page renders `data.sessions` in the order it receives them, and its own
	// refresh sorts the same way. Spreading the rest of the row rather than picking fields keeps any
	// field Better Auth adds later flowing through to the page.
	const sessions = rows
		.map(({ token: _token, ...rest }) => rest)
		.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
	return { sessions };
};
