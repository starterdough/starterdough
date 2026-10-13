// @ts-check

/**
 * Which of the two content sets this docs build serves. Read by `astro.config.mjs` (title, sidebar)
 * and `src/content.config.ts` (the folder the `docs` collection loads), so both always agree.
 *
 * - `product` (the default, also when unset or blank): your product's own documentation, from
 *   `src/content/product/`, plus the interactive API reference. This is what a deploy publishes.
 * - `kit`: the kit's developer manual, from `src/content/docs/`. Read it locally with
 *   `bun run dev:manual`. It documents the kit, not your product, so no deploy builds it unless a
 *   build sets `DOCS_CONTENT=kit` (the kit's own reference deployment does).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {'product' | 'kit'}
 */
export function docsContent(env = process.env) {
	const value = env.DOCS_CONTENT?.trim() || 'product';
	if (value !== 'product' && value !== 'kit') {
		throw new Error(`DOCS_CONTENT must be "product" or "kit" (or unset): got "${value}".`);
	}
	return value;
}

/** The collection base for each set, relative to apps/docs. */
export const CONTENT_DIRECTORY = {
	product: './src/content/product',
	kit: './src/content/docs',
};
