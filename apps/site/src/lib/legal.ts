/**
 * The legal pages ship as templates: bold `**[Placeholder]**` spans and a "Template: review with
 * counsel" note. A production build refuses to publish one that still has either, as
 * `astro.config.mjs` refuses a missing or placeholder `SITE_URL`.
 *
 * Pure on purpose (no `astro:content`), so `legal.test.ts` can run it under `bun test`.
 */

/** `**[Company name]**`, also when the bracket wraps onto the next line. */
const PLACEHOLDER = /\*\*\[[^\]]+\]\*\*/g;
const TEMPLATE_NOTE = '**Template: review with counsel.**';

/**
 * Hosts that are never a public deployment: loopback and the reserved names of RFC 2606 and
 * RFC 6761. CI builds for `https://ci.invalid` and `bun run setup` gives the site
 * `http://localhost:4321`, so neither has to fill the templates in.
 */
const NOT_PUBLIC = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$|\.(invalid|test|localhost|example)$/;

export interface LegalSource {
	/** Path from `apps/site`, as Astro reports it (`src/content/legal/terms.md`). */
	filePath?: string;
	id: string;
	body?: string;
}

/** What is still template text in one document, in the order it appears. Comments are skipped. */
export function templateLeftovers(body: string): string[] {
	// An HTML comment never renders; the templates keep the other edition's wording in one.
	const visible = body.replace(/<!--[\s\S]*?-->/g, '');
	const found = [...visible.matchAll(PLACEHOLDER)].map((match) => match[0].replace(/\s+/g, ' '));
	if (visible.includes(TEMPLATE_NOTE)) found.push('the "Template: review with counsel" note');
	return [...new Set(found)];
}

/** True when a build publishes to a real origin and nobody asked to publish the templates. */
export function guardsLegal(site: URL, allow: string | undefined): boolean {
	if (['1', 'true'].includes(allow?.trim().toLowerCase() ?? '')) return false;
	return !NOT_PUBLIC.test(site.hostname.toLowerCase());
}

/** Throws one error naming every unfinished file, or returns when there is none. */
export function assertLegalFinished(docs: LegalSource[]): void {
	const unfinished = docs
		.map((doc) => ({ doc, leftovers: templateLeftovers(doc.body ?? '') }))
		.filter(({ leftovers }) => leftovers.length > 0);
	if (unfinished.length === 0) return;
	const lines = unfinished.map(
		({ doc, leftovers }) =>
			`  apps/site/${doc.filePath ?? `src/content/legal/${doc.id}.md`}: ${leftovers.join(', ')}`,
	);
	throw new Error(
		[
			'The legal pages are still the kit’s templates, and this build publishes them:',
			...lines,
			'Fill in every placeholder, remove the template note and have the text reviewed ' +
				'(QUICKSTART.md, Step 2 B). To publish them unfinished on purpose, for a staging ' +
				'deployment, set ALLOW_LEGAL_PLACEHOLDERS=1 for the build.',
		].join('\n'),
	);
}
