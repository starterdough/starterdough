import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/** `/admin` has no content of its own; users are the section admins open most. */
export const load: PageLoad = () => {
	redirect(303, '/admin/users');
};
