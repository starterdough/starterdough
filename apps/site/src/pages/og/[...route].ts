import { getCollection } from 'astro:content';
import { OGImageRoute } from 'astro-og-canvas';
import { SITE_NAME, staticPages } from '../../lib/site';

/**
 * Open Graph images, rendered at build time with astro-og-canvas (CanvasKit, no runtime).
 * One image per static page (`src/lib/site.ts`), blog post and legal document, at
 * `/og/<key>.png`, the same key `Base.astro` derives from the pathname, so every page's
 * `og:image` exists. Fonts are fetched from fontsource once per build and cached in
 * `node_modules/.astro-og-canvas`.
 */
interface OGPage {
	title: string;
	description: string;
}

const [posts, legal] = await Promise.all([getCollection('blog'), getCollection('legal')]);

const pages: Record<string, OGPage> = {
	...Object.fromEntries(
		staticPages.map((page) => [
			page.ogKey,
			{ title: page.ogKey === 'index' ? SITE_NAME : page.title, description: page.description },
		]),
	),
	...Object.fromEntries(
		posts.map((post) => [
			`blog/${post.id}`,
			{ title: post.data.title, description: post.data.description },
		]),
	),
	...Object.fromEntries(
		legal.map((doc) => [
			`legal/${doc.id}`,
			{ title: doc.data.title, description: doc.data.description },
		]),
	),
};

// The dark theme tokens, approximated in sRGB: background oklch(0.145 0 0), foreground oklch(0.985 0 0).
const BACKGROUND: [number, number, number] = [10, 10, 10];
const FOREGROUND: [number, number, number] = [250, 250, 250];
const MUTED: [number, number, number] = [163, 163, 163];

const FONT_REGULAR = 'https://api.fontsource.org/v1/fonts/inter/latin-400-normal.ttf';
const FONT_BOLD = 'https://api.fontsource.org/v1/fonts/inter/latin-700-normal.ttf';

// The route parameter (`route`) is read from this file's name; keys map to `/og/<key>.png`.
export const { getStaticPaths, GET } = await OGImageRoute<OGPage>({
	pages,
	getImageOptions: (_path, page) => ({
		title: page.title,
		description: page.description,
		bgGradient: [BACKGROUND],
		border: { color: FOREGROUND, width: 16, side: 'inline-start' },
		padding: 80,
		fonts: [FONT_REGULAR, FONT_BOLD],
		font: {
			title: { families: ['Inter'], weight: 'Bold', color: FOREGROUND, size: 72, lineHeight: 1.15 },
			description: {
				families: ['Inter'],
				weight: 'Normal',
				color: MUTED,
				size: 36,
				lineHeight: 1.4,
			},
		},
	}),
});
