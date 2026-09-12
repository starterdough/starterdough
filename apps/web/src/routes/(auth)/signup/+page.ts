import { redirect } from '@sveltejs/kit';
import { afterSignUp, safeNext } from '$lib/utils/redirect';
import { sessionFor } from '$lib/utils/session';
import type { PageLoad } from './$types';

/** Already signed in? Skip the form and continue to where the user was heading. */
export const load: PageLoad = async ({ fetch, url }) => {
	if (await sessionFor(fetch)) {
		redirect(303, safeNext(url.searchParams.get('next')) ?? afterSignUp(url));
	}
};
