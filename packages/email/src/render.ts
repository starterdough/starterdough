// How every email is built: the locales it is written in, the escaping, and the shared layout.
//
// Every value a template interpolates is attacker-controlled somewhere: a display name and
// a contact message are free text typed by whoever signed up, and every message leaves the
// operator's DKIM-signed domain. So escaping is not
// a per-template decision here: `defineTemplate` is the only way to build one, its copy returns
// `Html` values that only the `html` tagged template produces (escaping every interpolation), and
// it runs every subject through `headerValue()`. Forgetting is a type error, not a vulnerability.

/** The locales email is written in: the app's (`apps/web/project.inlang/settings.json`). */
export const EMAIL_LOCALES = ['en', 'de'] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];
/** The app's `baseLocale`: what a recipient gets when nothing says otherwise. */
export const DEFAULT_EMAIL_LOCALE: EmailLocale = 'en';

/** `de-AT` → `de`; anything this deployment does not write email in → `null`. */
export function emailLocale(value: string | null | undefined): EmailLocale | null {
	const primary = value?.trim().toLowerCase().split(/[-_]/)[0] ?? '';
	return (EMAIL_LOCALES as readonly string[]).includes(primary) ? (primary as EmailLocale) : null;
}

/**
 * The locale of the person whose request triggered an email: the best supported `Accept-Language`
 * entry, by weight and then by order, skipping `q=0` (which means "not this one"). The web app
 * sends its own locale there (`@repo/auth/client`'s `locale` option), so an account using the app
 * in German gets German mail; other clients get their browser's preference, and no header at all
 * gets `DEFAULT_EMAIL_LOCALE`.
 */
export function localeOf(request: Request | Headers | null | undefined): EmailLocale {
	const header =
		(request instanceof Request ? request.headers : request)?.get('accept-language') ?? '';
	const ranked = header
		.split(',')
		.map((entry, index) => {
			const [tag = '', ...parameters] = entry.split(';');
			const q = parameters.map((p) => p.trim()).find((p) => p.startsWith('q='));
			const weight = q ? Number(q.slice(2)) : 1;
			return { tag, weight: Number.isFinite(weight) ? weight : 0, index };
		})
		.filter((entry) => entry.weight > 0)
		.sort((a, b) => b.weight - a.weight || a.index - b.index);
	for (const { tag } of ranked) {
		const locale = emailLocale(tag);
		if (locale) return locale;
	}
	return DEFAULT_EMAIL_LOCALE;
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/** Markup that has already been escaped. Only `html` produces it. */
export class Html {
	constructor(readonly value: string) {}
	toString(): string {
		return this.value;
	}
}

/**
 * Tagged template for email markup: every `${…}` is HTML-escaped, so
 * ``html`<p>${name}</p>` `` is inert whatever `name` holds. Interpolate another `Html` to compose
 * without double-escaping.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
	let out = strings[0] ?? '';
	for (const [index, value] of values.entries()) {
		out += value instanceof Html ? value.value : escapeHtml(String(value ?? ''));
		out += strings[index + 1] ?? '';
	}
	return new Html(out);
}

/**
 * A value going into a mail header (only subjects, today). Header fields are single-line, so
 * control characters (CR/LF above all, but also the format and bidi-override code points that make
 * a display name render as something else) are replaced by a space rather than encoded: a name
 * holding `\r\nBcc: victim@example.com` must not be able to add a header. Whitespace runs collapse.
 */
export function headerValue(value: string): string {
	return value
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

const FOOTER: Record<EmailLocale, string> = {
	en: 'Sent by Starterdough',
	de: 'Gesendet von Starterdough',
};

function layout(locale: EmailLocale, title: Html, body: Html): string {
	return `<!doctype html><html lang="${locale}"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111;max-width:560px;margin:0 auto;padding:32px 16px">
<h1 style="font-size:20px">${title.value}</h1>${body.value}
<p style="color:#666;font-size:12px;margin-top:32px">${escapeHtml(FOOTER[locale])}</p></body></html>`;
}

/** What a template returns: spread into `email.send({ to, ...template })`. */
export interface RenderedEmail {
	subject: string;
	html: string;
	text: string;
}

/** One locale's copy of a template. `title` and `body` come from `html`; `text` is plain text. */
export interface EmailCopy {
	subject: string;
	title: Html;
	body: Html;
	text: string;
}

/** A template: its props, then the recipient's locale (`DEFAULT_EMAIL_LOCALE` when left out). */
export type EmailTemplate<Props> = (props: Props, locale?: EmailLocale | null) => RenderedEmail;

/**
 * Build a template from its copy in every locale. A locale added to `EMAIL_LOCALES` is a type error
 * in every template until its copy is written, the way a missing Paraglide message fails
 * `svelte-check`. The kit's templates are in `./templates.ts`, a product's in `./product.ts`.
 */
export function defineTemplate<Props>(
	copy: Record<EmailLocale, (props: Props) => EmailCopy>,
): EmailTemplate<Props> {
	return (props, locale) => {
		const chosen = locale ?? DEFAULT_EMAIL_LOCALE;
		const { subject, title, body, text } = copy[chosen](props);
		return { subject: headerValue(subject), html: layout(chosen, title, body), text };
	};
}
