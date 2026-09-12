import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { requireSite, SITE_NAME, SITE_TAGLINE } from '../lib/site';

export async function GET(context: APIContext) {
	const posts = (await getCollection('blog')).sort(
		(a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime(),
	);
	return rss({
		title: `${SITE_NAME} blog`,
		description: `${SITE_TAGLINE} Notes on how ${SITE_NAME} is built and why.`,
		site: requireSite(context.site),
		items: posts.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			pubDate: post.data.pubDate,
			author: post.data.author,
			categories: post.data.tags,
			link: `/blog/${post.id}/`,
		})),
		customData: '<language>en</language>',
	});
}
