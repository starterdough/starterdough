import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { PageLoad } from './$types';

/**
 * `/dev/ui` is the `@repo/ui` kitchen sink — a development tool, not a route of the product, so it
 * 404s in every build. Nothing links to it; open it after changing a token or a variant.
 */
export const prerender = false;

export const load: PageLoad = () => {
	if (!dev) error(404);
};
