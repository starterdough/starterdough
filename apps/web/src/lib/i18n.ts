import {
	baseLocale,
	getLocale,
	getTextDirection,
	type Locale,
	locales,
	setLocale,
} from './paraglide/runtime';

/**
 * Locale utilities on top of the Paraglide runtime (`$lib/paraglide/runtime`, generated from
 * `apps/web/messages/**`; see project.inlang/paraglide.config.ts for the strategy).
 *
 * Text comes from `import { m } from '$lib/paraglide/messages'`; this module covers what is not
 * a message: the switcher, `<html lang>` on the client, Intl formatting and Zod's own messages.
 */

export { baseLocale, getLocale, getTextDirection, type Locale, locales, setLocale };

/** The language's name in itself ("Deutsch", not "German"); never needs translating. */
export function localeName(locale: Locale): string {
	try {
		return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
	} catch {
		return locale;
	}
}

/**
 * Switch the UI language. Paraglide persists the choice (cookie) and reloads the document: every
 * message is a plain function call, so a full render is the only way to re-evaluate them all.
 */
export function switchLocale(locale: Locale) {
	if (locale === getLocale()) return;
	setLocale(locale);
}

/** Keep `<html lang/dir>` truthful on the client (the static SPA shell is rendered without a request). */
export function syncDocumentLocale() {
	const locale = getLocale();
	document.documentElement.lang = locale;
	document.documentElement.dir = getTextDirection(locale);
}

// ---- Intl -------------------------------------------------------------------------------------

export function formatDate(
	value: Date | string | number,
	options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
	return new Intl.DateTimeFormat(getLocale(), options).format(new Date(value));
}

export function formatDateTime(value: Date | string | number): string {
	return formatDate(value, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
	return new Intl.NumberFormat(getLocale(), options).format(value);
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;

/** "512 bytes", "1.5 kB", "24.6 MB": decimal units (matching Intl's SI labels), at most one decimal. */
export function formatBytes(bytes: number): string {
	let value = Math.max(0, bytes);
	let index = 0;
	while (value >= 1000 && index < BYTE_UNITS.length - 1) {
		value /= 1000;
		index += 1;
	}
	return formatNumber(value, {
		style: 'unit',
		unit: BYTE_UNITS[index],
		// Intl's short form of the base unit is "byte" even in the plural; the long form pluralises.
		unitDisplay: index === 0 ? 'long' : 'short',
		maximumFractionDigits: 1,
	});
}

/** "4.2 sec", "1 min 12 sec", "2 hr 5 min": how long something took, coarse past a minute. */
export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, milliseconds) / 1000;
	const unit = (value: number, name: 'second' | 'minute' | 'hour') =>
		formatNumber(value, {
			style: 'unit',
			unit: name,
			unitDisplay: 'short',
			maximumFractionDigits: name === 'second' && value < 10 ? 1 : 0,
		});
	if (seconds < 60) return unit(seconds, 'second');
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return formatList([unit(minutes, 'minute'), unit(Math.floor(seconds % 60), 'second')], {
			type: 'unit',
			style: 'narrow',
		});
	}
	return formatList([unit(Math.floor(minutes / 60), 'hour'), unit(minutes % 60, 'minute')], {
		type: 'unit',
		style: 'narrow',
	});
}

/** "a, b and c" with the locale's conjunction and punctuation. */
export function formatList(
	items: Iterable<string>,
	options: Intl.ListFormatOptions = { type: 'conjunction' },
): string {
	return new Intl.ListFormat(getLocale(), options).format(items);
}

/** "3 minutes ago", "in 2 days": picks the largest unit that fits. */
export function formatRelative(value: Date | string | number, now = Date.now()): string {
	const diff = (new Date(value).getTime() - now) / 1000;
	const abs = Math.abs(diff);
	const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
	if (abs < 60) return rtf.format(Math.round(diff), 'second');
	if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
	if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
	if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
	if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
	return rtf.format(Math.round(diff / (86400 * 365)), 'year');
}

// ---- Zod ---------------------------------------------------------------------------------------

/**
 * Zod's built-in messages ("Invalid input", "Too small…") in the current locale. Our forms phrase
 * the common issues themselves (`$lib/forms` → `zodForm`); this covers the rest. Client-only: forms
 * validate in the browser (SPA mode), and a process-wide config would leak between SSR requests.
 *
 * Loaded on demand rather than imported: every page's root layout calls this, but only the pages
 * with a form carry Zod, and the landing page must not download it for a message it never shows.
 */
export async function applyZodLocale() {
	const [z, locales] = await Promise.all([import('zod'), import('zod/locales')]);
	z.config(locales[getLocale()]());
}
