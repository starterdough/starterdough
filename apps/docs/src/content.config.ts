import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { glob } from 'astro/loaders';
import { CONTENT_DIRECTORY, docsContent } from '../content-set.mjs';

/**
 * Starlight's `docsLoader()` is this glob pinned to `src/content/docs/`. The base follows
 * DOCS_CONTENT instead (content-set.mjs): your product's docs by default, the kit's manual on
 * request. Files starting with `_` are skipped, as Starlight does.
 */
export const collections = {
	docs: defineCollection({
		loader: glob({
			base: CONTENT_DIRECTORY[docsContent()],
			pattern: '**/[^_]*.{md,mdx}',
		}),
		schema: docsSchema(),
	}),
};
