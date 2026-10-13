import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { published } from '../lib/content';
import { requireSite, SITE_NAME, SITE_TAGLINE } from '../lib/site';

export async function GET(context: APIContext) {
	const posts = (await published('blog')).sort(
		(a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime(),
	);
	return rss({
		title: `${SITE_NAME} blog`,
		description: `${SITE_TAGLINE} News and articles from ${SITE_NAME}.`,
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
