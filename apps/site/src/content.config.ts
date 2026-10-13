import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/**
 * Blog posts: `src/content/blog/<slug>.md`, served at `/blog/<slug>` and in `/rss.xml`. Yours: the
 * kit ships one draft sample and never adds or changes a post in an upgrade.
 */
const blog = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		pubDate: z.coerce.date(),
		author: z.string(),
		tags: z.array(z.string()).default([]),
		/** Shown by `astro dev`, left out of a build (src/lib/content.ts). */
		draft: z.boolean().default(false),
	}),
});

/**
 * Your release notes: `src/content/changelog/<file>.md`, all rendered on `/changelog`. The kit
 * ships one draft sample and never adds or changes an entry in an upgrade; its own history is
 * `CHANGELOG.md` at the repository root.
 */
const changelog = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/changelog' }),
	schema: z.object({
		title: z.string(),
		version: z.string(),
		date: z.coerce.date(),
		/** Shown by `astro dev`, left out of a build (src/lib/content.ts). */
		draft: z.boolean().default(false),
	}),
});

/** Legal templates: `src/content/legal/<slug>.md`, served at `/legal/<slug>`. */
const legal = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/legal' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		updated: z.coerce.date(),
	}),
});

export const collections = { blog, changelog, legal };
