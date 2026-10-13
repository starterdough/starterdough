import { describe, expect, it } from 'bun:test';

process.env.SKIP_ENV_VALIDATION ??= '1';
const { DEFAULT_EMAIL_LOCALE, EMAIL_LOCALES, headerValue, html, localeOf, templates } =
	await import('./index');

/** What an attacker types into their display name: markup that would render as our own copy. */
const PHISHING = '</strong><a href="https://evil.example/reset">Reset your password</a>';

describe('email templates', () => {
	it('renders the account-lifecycle templates with their action links', () => {
		const url = 'https://api.example.com/api/auth/x?token=t';
		for (const message of [
			templates.verifyEmail({ name: 'Ada', url }),
			templates.resetPassword({ name: 'Ada', url }),
			templates.changeEmailConfirmation({ name: 'Ada', newEmail: 'new@example.com', url }),
			templates.deleteAccount({ name: 'Ada', url }),
		]) {
			expect(message.subject.length).toBeGreaterThan(0);
			expect(message.html).toContain(`href="${url}"`);
			expect(message.text).toContain(url);
		}
		expect(
			templates.changeEmailConfirmation({ name: 'Ada', newEmail: 'new@example.com', url }).html,
		).toContain('new@example.com');
	});

	it('renders an attacker-chosen display name as text, not as markup', () => {
		const url = 'https://api.example.com/api/auth/verify?token=t';
		const message = templates.verifyEmail({ name: PHISHING, url });
		// The payload survives as visible text …
		expect(message.html).toContain('Reset your password');
		// … but no tag or attribute of it reaches the document.
		expect(message.html).not.toContain('<a href="https://evil.example/reset">');
		expect(message.html).toContain('&lt;a href=&quot;https://evil.example/reset&quot;&gt;');
		// Our own markup is still markup, and the link we generated is still a link.
		expect(message.html).toContain(`<a href="${url}">`);
	});

	it('flattens a subject a display name tried to add headers to', () => {
		const message = templates.contactMessage({
			name: 'Ada\r\nBcc: victim@example.com',
			email: 'ada@example.com',
			message: 'Hello',
		});
		expect(message.subject).toBe('New message from Ada Bcc: victim@example.com <ada@example.com>');
		expect(message.subject).not.toContain('\r');
		expect(message.subject).not.toContain('\n');
	});

	it('strips control, format and bidi code points from header values', () => {
		// LEFT-TO-RIGHT MARK, RIGHT-TO-LEFT OVERRIDE and BELL are invisible in a mail client but
		// change what the recipient reads; a subject is one line of plain text or nothing.
		const lrm = String.fromCodePoint(0x200e);
		const rlo = String.fromCodePoint(0x202e);
		const bell = String.fromCodePoint(0x0007);
		expect(headerValue(`a b${lrm}c${rlo}d${bell}e\t\nf  `)).toBe('a b c d e f');
	});

	it('composes nested markup without double-escaping it', () => {
		expect(html`<p>${html`<b>${'a & b'}</b>`}</p>`.value).toBe('<p><b>a &amp; b</b></p>');
	});
});

describe('email locales', () => {
	const url = 'https://api.example.com/api/auth/x?token=t';

	it('writes the account templates in German when asked, and in English otherwise', () => {
		const german = templates.verifyEmail({ name: 'Ada', url }, 'de');
		expect(german.subject).toBe('Bestätige deine E-Mail-Adresse');
		expect(german.html).toContain('<html lang="de">');
		expect(german.html).toContain('Gesendet von');
		expect(german.html).toContain(`href="${url}"`);
		expect(german.text).toContain(url);
		for (const message of [
			templates.resetPassword({ name: 'Ada', url }, 'de'),
			templates.changeEmailConfirmation({ name: 'Ada', newEmail: 'new@example.com', url }, 'de'),
			templates.deleteAccount({ name: 'Ada', url }, 'de'),
		]) {
			expect(message.html).toContain('<html lang="de">');
			expect(message.html).toContain(`href="${url}"`);
			expect(message.text).toContain('Hallo Ada');
		}
		expect(templates.resetPassword({ name: 'Ada', url }, 'de').subject).toBe(
			'Setze dein Passwort zurück',
		);

		const english = templates.verifyEmail({ name: 'Ada', url });
		expect(english.subject).toBe('Verify your email');
		expect(english.html).toContain('<html lang="en">');
		expect(english.html).toContain('Sent by');
		expect(templates.verifyEmail({ name: 'Ada', url }, null)).toEqual(english);
	});

	it('escapes the German copy like the English', () => {
		const message = templates.verifyEmail({ name: PHISHING, url }, 'de');
		expect(message.html).not.toContain('<a href="https://evil.example/reset">');
		expect(message.html).toContain('&lt;a href=&quot;https://evil.example/reset&quot;&gt;');
	});

	it('takes the best supported language a request names', () => {
		const request = (value: string) =>
			new Request('https://api.example.com', { headers: { 'accept-language': value } });
		expect(localeOf(request('de'))).toBe('de');
		expect(localeOf(request('de-AT'))).toBe('de');
		expect(localeOf(request('fr-FR, de-AT;q=0.8, en;q=0.5'))).toBe('de');
		expect(localeOf(request('en;q=0.4, de;q=0.9'))).toBe('de');
		expect(localeOf(request('de, en'))).toBe('de');
		expect(localeOf(request('fr, ja'))).toBe(DEFAULT_EMAIL_LOCALE);
		// `q=0` means "not this one", and a weight that is not a number counts as nothing.
		expect(localeOf(request('de;q=0'))).toBe(DEFAULT_EMAIL_LOCALE);
		expect(localeOf(request('de;q=x, en;q=0.1'))).toBe('en');
		expect(localeOf(new Headers({ 'accept-language': 'de-CH' }))).toBe('de');
		expect(localeOf(request(''))).toBe(DEFAULT_EMAIL_LOCALE);
		expect(localeOf(undefined)).toBe(DEFAULT_EMAIL_LOCALE);
	});

	it('writes email in exactly the locales the app has', async () => {
		const settings = await Bun.file(
			new URL('../../../apps/web/project.inlang/settings.json', import.meta.url),
		).json();
		expect([...EMAIL_LOCALES].sort()).toEqual([...settings.locales].sort());
		expect(DEFAULT_EMAIL_LOCALE).toBe(settings.baseLocale);
	});
});
