import { type CollectionEntry, getCollection } from 'astro:content';

/**
 * Blog posts and release notes a build publishes. An entry with `draft: true` (the kit's samples
 * are drafts) shows in `astro dev` and is left out of every build, the feed and the sitemap.
 */
export async function published<C extends 'blog' | 'changelog'>(
	collection: C,
): Promise<CollectionEntry<C>[]> {
	const entries = (await getCollection(collection)) as CollectionEntry<C>[];
	return entries.filter((entry) => import.meta.env.DEV || !entry.data.draft);
}
