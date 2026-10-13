import { env, isProduction } from '@repo/env';
import { Resend } from 'resend';
import { productTemplates } from './product';
import { kitTemplates } from './templates';

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
		// Bodies carry verification and password-reset URLs, i.e. live credentials, so they are
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

// Swap providers by environment. Add SMTP (nodemailer) here for fully self-hosted setups, and add
// its switch to the production rules in `packages/env` (`emailConfigurationIssues`) at the same time.
export const email: EmailProvider = env.RESEND_API_KEY
	? resendProvider(env.RESEND_API_KEY)
	: consoleProvider;

// ── Templates ──────────────────────────────────────────────────────────────────
// Plain functions returning HTML + text, one copy per locale: the kit's in `./templates.ts`, the
// product's in `./product.ts`, both built with `defineTemplate` (`./render.ts` has the escaping).

export {
	DEFAULT_EMAIL_LOCALE,
	defineTemplate,
	EMAIL_LOCALES,
	type EmailCopy,
	type EmailLocale,
	type EmailTemplate,
	emailLocale,
	escapeHtml,
	Html,
	headerValue,
	html,
	localeOf,
	type RenderedEmail,
} from './render';

// A product template named like one of the kit's would vanish in the spread below, where the kit's
// wins, so the product's own calls would send the kit's mail. Refuse it at start-up instead.
for (const name of Object.keys(productTemplates)) {
	if (Object.hasOwn(kitTemplates, name)) {
		throw new Error(`email template ${name} is the kit's; give the product's another name`);
	}
}

/** Every template: `templates.verifyEmail({ name, url }, locale)`; the locale is optional. */
export const templates = { ...productTemplates, ...kitTemplates };
