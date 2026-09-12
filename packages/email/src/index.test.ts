import { describe, expect, it } from 'bun:test';

process.env.SKIP_ENV_VALIDATION ??= '1';
const { headerValue, html, templates } = await import('./index');

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
