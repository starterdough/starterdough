import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Locale → catalogue file name → the message keys in it. */
type Catalogues = Record<string, Record<string, string[]>>;

/**
 * What each locale lacks that another locale has: a whole catalogue file, or a key in a file they
 * both have. Paraglide compiles either without a word, `check` included: a key German lacks renders
 * in English, and one English lacks renders as the key's own name.
 */
function gaps(catalogues: Catalogues): string[] {
	const locales = Object.keys(catalogues);
	const files = new Set(locales.flatMap((locale) => Object.keys(catalogues[locale] ?? {})));
	const found: string[] = [];
	for (const file of [...files].sort()) {
		const keys = new Set(locales.flatMap((locale) => catalogues[locale]?.[file] ?? []));
		for (const locale of locales) {
			const own = catalogues[locale]?.[file];
			if (!own) {
				found.push(`${locale}/${file} is missing`);
				continue;
			}
			const present = new Set(own);
			for (const key of [...keys].sort()) {
				if (!present.has(key)) found.push(`${locale}/${file} lacks ${key}`);
			}
		}
	}
	return found;
}

describe('message catalogues', () => {
	const web = fileURLToPath(new URL('../..', import.meta.url));
	const settings = JSON.parse(
		readFileSync(join(web, 'project.inlang', 'settings.json'), 'utf8'),
	) as { baseLocale: string; locales: string[] };

	/** Every locale `project.inlang` compiles, each read from `messages/<locale>/*.json`. */
	function read(): Catalogues {
		return Object.fromEntries(
			settings.locales.map((locale) => {
				const dir = join(web, 'messages', locale);
				const files = existsSync(dir)
					? readdirSync(dir).filter((name) => name.endsWith('.json'))
					: [];
				return [
					locale,
					Object.fromEntries(
						files.map((file) => {
							const catalogue = JSON.parse(readFileSync(join(dir, file), 'utf8')) as object;
							// `$schema` names the file format; it is not a message.
							return [file, Object.keys(catalogue).filter((key) => key !== '$schema')];
						}),
					),
				];
			}),
		);
	}

	it('are compared key by key and file by file', () => {
		expect(
			gaps({
				en: { 'app.json': ['app_title', 'app_save'], 'admin.json': ['admin_title'] },
				de: { 'app.json': ['app_title', 'app_delete'] },
			}),
		).toEqual([
			'de/admin.json is missing',
			'en/app.json lacks app_delete',
			'de/app.json lacks app_save',
		]);
		const same = { 'app.json': ['app_title'] };
		expect(gaps({ en: same, de: same })).toEqual([]);
	});

	it('have the same keys in every locale', () => {
		const catalogues = read();
		// Nothing read would compare as nothing missing.
		expect(Object.keys(catalogues[settings.baseLocale] ?? {})).not.toEqual([]);
		expect(gaps(catalogues)).toEqual([]);
	});
});
