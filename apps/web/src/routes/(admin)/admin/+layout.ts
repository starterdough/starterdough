import { isAdmin } from '@repo/auth/permissions';
import { error, redirect } from '@sveltejs/kit';
import { m } from '$lib/paraglide/messages';
import { sessionResult } from '$lib/utils/session';
import type { LayoutLoad } from './$types';

/**
 * Guard for everything under /admin. Universal like the `/app` one: SSR redirects anonymous
 * visitors before any HTML is sent, the static build does the same in the browser. Only the
 * platform role (Better Auth `user.role`, not organization roles) opens the door; the API
 * re-checks it on every `admin.*` procedure and `/api/auth/admin/*` route, so this only decides
 * what is rendered.
 */
export const load: LayoutLoad = async ({ fetch, url }) => {
	const { session, reason } = await sessionResult(fetch);
	if (!session) {
		// Unreachable is an outage, not a sign-out — see the `/app` guard.
		if (reason === 'unreachable') error(503, m.common_api_unreachable());
		redirect(303, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	}
	if (!isAdmin(session.user.role)) redirect(303, '/app');
	return { session };
};
