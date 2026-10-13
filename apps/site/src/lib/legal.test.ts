import { describe, expect, it } from 'bun:test';
import { assertLegalFinished, guardsLegal, templateLeftovers } from './legal';

/**
 * Shaped like the templates the kit ships, not read from them: once you fill yours in, this file
 * still tests the guard rather than your text.
 */
const NOTE =
	'> **Template: review with counsel.** Replace every `[placeholder]` before publishing.\n';
const shipped = [
	{
		id: 'privacy',
		filePath: 'src/content/legal/privacy.md',
		body: `${NOTE}\nThis policy describes how **[Company name]** handles data at **[Service URL]**.\n`,
	},
	{
		id: 'terms',
		filePath: 'src/content/legal/terms.md',
		body: `${NOTE}\nThese terms are governed by the laws of **[Jurisdiction]**.\n`,
	},
];

describe('legal templates in a production build', () => {
	it('refuses the shipped templates, naming each file and what is left', () => {
		expect(() => assertLegalFinished(shipped)).toThrow(
			/apps\/site\/src\/content\/legal\/privacy\.md: \*\*\[Company name\]\*\*/,
		);
		expect(() => assertLegalFinished(shipped)).toThrow('apps/site/src/content/legal/terms.md');
		expect(() => assertLegalFinished(shipped)).toThrow('ALLOW_LEGAL_PLACEHOLDERS=1');
	});

	it('passes a document whose placeholders are filled and whose note is gone', () => {
		const filled = '# Terms\n\nProvided by **Acme Inc.** at **https://acme.com**.\n';
		expect(templateLeftovers(filled)).toEqual([]);
		expect(() => assertLegalFinished([{ id: 'terms', body: filled }])).not.toThrow();
	});

	it('finds a placeholder that wraps onto the next line, and the template note on its own', () => {
		expect(templateLeftovers('cap. **[Adjust to your\njurisdiction.]**')).toEqual([
			'**[Adjust to your jurisdiction.]**',
		]);
		expect(templateLeftovers('> **Template: review with counsel.** Replace it.')).toEqual([
			'the "Template: review with counsel" note',
		]);
	});

	it('ignores a placeholder inside an HTML comment, and plain links', () => {
		const body = 'Run by **Acme**. See [our terms](/legal/terms/).\n<!--\n// **[Venue]**\n-->\n';
		expect(templateLeftovers(body)).toEqual([]);
	});

	it('applies to real origins only, unless the build opts out', () => {
		expect(guardsLegal(new URL('https://acme.com'), undefined)).toBe(true);
		expect(guardsLegal(new URL('https://www.acme.co.uk'), '')).toBe(true);
		for (const local of [
			'http://localhost:4321',
			'http://127.0.0.1:4321',
			'https://ci.invalid',
			'https://publish-gate.invalid',
			'https://www.customer.test',
			'http://site.localhost',
		]) {
			expect(guardsLegal(new URL(local), undefined)).toBe(false);
		}
		expect(guardsLegal(new URL('https://acme.com'), '1')).toBe(false);
		expect(guardsLegal(new URL('https://acme.com'), 'true')).toBe(false);
		expect(guardsLegal(new URL('https://acme.com'), '0')).toBe(true);
	});
});
