import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/** Blog posts — `src/content/blog/<slug>.md`, served at `/blog/<slug>` and in `/rss.xml`. */
const blog = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		pubDate: z.coerce.date(),
		author: z.string(),
		tags: z.array(z.string()).default([]),
	}),
});

/** Release notes — `src/content/changelog/<version>.md`, all rendered on `/changelog`. */
const changelog = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/changelog' }),
	schema: z.object({
		title: z.string(),
		version: z.string(),
		date: z.coerce.date(),
	}),
});

/** Legal templates — `src/content/legal/<slug>.md`, served at `/legal/<slug>`. */
const legal = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/legal' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		updated: z.coerce.date(),
	}),
});

export const collections = { blog, changelog, legal };
