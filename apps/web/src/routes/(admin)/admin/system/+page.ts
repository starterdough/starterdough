import { apiFor } from '$lib/api';
import type { PageLoad } from './$types';

/**
 * Snapshot of the deployment so SSR renders the cards; Refresh re-fetches in place. A failure
 * falls back to `null` and the page fetches again on the client to surface the actual error
 * instead of a 500.
 */
export const load: PageLoad = async ({ fetch }) => {
	const status = await apiFor(fetch)
		.admin.system.status()
		.catch(() => null);
	return { status };
};
