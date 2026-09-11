import { authFor } from '$lib/auth';
import type { PageLoad } from './$types';

/**
 * First page of users (newest first) so SSR renders the table; the page re-queries on search,
 * paging and after every action. A failure falls back to `null` and the page fetches again on
 * the client to surface the actual error instead of a 500.
 */
export const load: PageLoad = async ({ fetch }) => {
	const result = await authFor(fetch)
		.admin.listUsers({
			query: { limit: 25, offset: 0, sortBy: 'createdAt', sortDirection: 'desc' },
		})
		.catch(() => null);
	return { users: result?.data ?? null };
};
