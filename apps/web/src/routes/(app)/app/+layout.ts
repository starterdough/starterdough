import { error, redirect } from '@sveltejs/kit';
import { flagsFor } from '$lib/flags';
import { m } from '$lib/paraglide/messages';
import { sessionResult } from '$lib/utils/session';
import type { LayoutLoad } from './$types';

/**
 * Session guard for everything under /app. Universal on purpose: the static (Tauri) build
 * has no server, while the server-rendered targets still run this during SSR, so anonymous
 * visitors are redirected before any HTML is sent. Data access is protected by the API.
 *
 * Also seeds the feature flags (`page.data.flags`, `$lib/flags`).
 */
export const load: LayoutLoad = async ({ fetch, url }) => {
	const { session, reason } = await sessionResult(fetch);
	if (!session) {
		// An API that did not answer is an outage, not a sign-out: sending the user to /login would
		// lose their place and offer a form that cannot work either. The error page says so and
		// offers Reload.
		if (reason === 'unreachable') error(503, m.common_api_unreachable());
		redirect(303, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	}
	return { session, flags: await flagsFor(fetch) };
};
