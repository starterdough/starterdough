import { redirect } from '@sveltejs/kit';
import { safeNext } from '#lib/utils/redirect.js';
import { sessionFor } from '#lib/utils/session.js';
import type { PageLoad } from './$types';

/** Already signed in? Skip the form and continue to where the user was heading. */
export const load: PageLoad = async ({ fetch, url }) => {
	if (await sessionFor(fetch)) redirect(303, safeNext(url.searchParams.get('next')) ?? '/app');
};
