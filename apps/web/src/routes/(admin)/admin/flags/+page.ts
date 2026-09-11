import { apiFor } from '$lib/api';
import type { PageLoad } from './$types';

/**
 * Every flag so SSR renders the list; mutations replace rows in place with
 * what the API returns. A failure falls back to `null` and the page fetches again on the client
 * to surface the actual error instead of a 500.
 */
export const load: PageLoad = async ({ fetch }) => {
	const flags = await apiFor(fetch)
		.admin.flags.list()
		.catch(() => null);
	return { flags };
};
