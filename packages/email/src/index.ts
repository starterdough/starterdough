import { env, isProduction } from '@repo/env';
import { Resend } from 'resend';

export interface EmailMessage {
	to: string | string[];
	subject: string;
	html: string;
	text?: string;
	replyTo?: string;
}

export interface EmailProvider {
	readonly name: string;
	send(message: EmailMessage): Promise<{ id: string }>;
}

/** Development provider: prints the message instead of sending it. */
export const consoleProvider: EmailProvider = {
	name: 'console',
	async send(message) {
		const to = Array.isArray(message.to) ? message.to.join(', ') : message.to;
		// Bodies carry verification and password-reset URLs — i.e. live credentials — so they are
		// only ever printed outside production. `packages/env` refuses to boot production without
		// a real provider; this is the second line of that defence, not a fallback.
		if (isProduction) {
			console.warn(
				`[email] NOT SENT (no email provider configured) to: ${to} — ${message.subject}`,
			);
			return { id: `console-${Date.now()}` };
		}
		console.log(
			`\n[email] to: ${to}\n[email] subject: ${message.subject}\n${message.text ?? message.html}\n`,
		);
		return { id: `console-${Date.now()}` };
	},
};

export function resendProvider(apiKey: string): EmailProvider {
	const resend = new Resend(apiKey);
	return {
		name: 'resend',
		async send(message) {
			const { data, error } = await resend.emails.send({
				from: env.EMAIL_FROM,
				to: message.to,
				subject: message.subject,
				html: message.html,
				text: message.text,
				replyTo: message.replyTo,
			});
			if (error) throw new Error(`Resend: ${error.message}`);
			return { id: data?.id ?? '' };
		},
	};
}

// Swap providers by environment. Add SMTP (nodemailer) here for fully self-hosted setups — and add
// its switch to the production rules in `packages/env` (`emailConfigurationIssues`) at the same time.
export const email: EmailProvider = env.RESEND_API_KEY
	? resendProvider(env.RESEND_API_KEY)
	: consoleProvider;

// ── Templates ──────────────────────────────────────────────────────────────────
// Plain functions returning HTML + text. Replace with MJML/Svelte-rendered templates later.
//
// Every value these templates interpolate is attacker-controlled somewhere: a display name and
// a contact message are free text typed by whoever signed up, and every message leaves the
// operator's DKIM-signed domain. So escaping is not
// a per-template decision here: `message()` is the only way to build one, it takes `Html` values
// that can only come from the `html` tagged template (which escapes every interpolation), and it
// runs every subject through `headerValue()`. Forgetting is a type error, not a vulnerability.

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
 * control characters — CR/LF above all, but also the format and bidi-override code points that make
 * a display name render as something else — are replaced by a space rather than encoded: a name
 * holding `\r\nBcc: victim@example.com` must not be able to add a header. Whitespace runs collapse.
 */
export function headerValue(value: string): string {
	return value
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function layout(title: Html, body: Html): string {
	return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111;max-width:560px;margin:0 auto;padding:32px 16px">
<h1 style="font-size:20px">${title.value}</h1>${body.value}
<p style="color:#666;font-size:12px;margin-top:32px">Sent by Starterdough</p></body></html>`;
}

/** What a template returns: spread into `email.send({ to, ...template })`. */
export interface RenderedEmail {
	subject: string;
	html: string;
	text: string;
}

/** The one constructor for an outgoing message: sanitises the subject, wraps the escaped body. */
function message(subject: string, title: Html, body: Html, text: string): RenderedEmail {
	return { subject: headerValue(subject), html: layout(title, body), text };
}

export const templates = {
	verifyEmail({ name, url }: { name: string; url: string }) {
		return message(
			'Verify your email',
			html`Verify your email`,
			html`<p>Hi ${name},</p><p><a href="${url}">Click here to verify your email address.</a></p>`,
			`Hi ${name},\n\nVerify your email: ${url}`,
		);
	},
	resetPassword({ name, url }: { name: string; url: string }) {
		return message(
			'Reset your password',
			html`Reset your password`,
			html`<p>Hi ${name},</p><p><a href="${url}">Choose a new password.</a> This link expires soon.</p>`,
			`Hi ${name},\n\nReset your password: ${url}`,
		);
	},
	/** Sent to the *current* address so the owner approves the change. */
	changeEmailConfirmation({
		name,
		newEmail,
		url,
	}: {
		name: string;
		newEmail: string;
		url: string;
	}) {
		return message(
			'Confirm your new email address',
			html`Confirm your new email address`,
			html`<p>Hi ${name},</p><p>You asked to change your sign-in email to <strong>${newEmail}</strong>.</p><p><a href="${url}">Confirm the change.</a> If this wasn't you, ignore this email and consider changing your password.</p>`,
			`Hi ${name},\n\nConfirm changing your email to ${newEmail}: ${url}\n\nIf this wasn't you, ignore this email.`,
		);
	},
	deleteAccount({ name, url }: { name: string; url: string }) {
		return message(
			'Confirm account deletion',
			html`Delete your account`,
			html`<p>Hi ${name},</p><p>This will permanently delete your account and everything in it.</p><p><a href="${url}">Yes, delete my account.</a> If this wasn't you, ignore this email.</p>`,
			`Hi ${name},\n\nConfirm deleting your account: ${url}\n\nIf this wasn't you, ignore this email.`,
		);
	},
	/** Public contact / waitlist form → the operator (`CONTACT_EMAIL`), reply-to set to the sender. */
	contactMessage({
		name,
		email,
		message: body,
	}: {
		name?: string;
		email: string;
		message: string;
	}) {
		const from = name ? `${name} <${email}>` : email;
		return message(
			`New message from ${from}`,
			html`New message from the website`,
			html`<p><strong>From:</strong> ${from}</p><p style="white-space:pre-wrap">${body}</p>`,
			`From: ${from}\n\n${body}`,
		);
	},
};
