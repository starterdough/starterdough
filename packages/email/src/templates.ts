import { defineTemplate, html } from './render';

type Link = { name: string; url: string };

/** The kit's own messages, in every locale of `EMAIL_LOCALES`. A product's go in `./product.ts`. */
export const kitTemplates = {
	verifyEmail: defineTemplate<Link>({
		en: ({ name, url }) => ({
			subject: 'Verify your email',
			title: html`Verify your email`,
			body: html`<p>Hi ${name},</p><p><a href="${url}">Click here to verify your email address.</a></p>`,
			text: `Hi ${name},\n\nVerify your email: ${url}`,
		}),
		de: ({ name, url }) => ({
			subject: 'Bestätige deine E-Mail-Adresse',
			title: html`Bestätige deine E-Mail-Adresse`,
			body: html`<p>Hallo ${name},</p><p><a href="${url}">Klicke hier, um deine E-Mail-Adresse zu bestätigen.</a></p>`,
			text: `Hallo ${name},\n\nBestätige deine E-Mail-Adresse: ${url}`,
		}),
	}),
	resetPassword: defineTemplate<Link>({
		en: ({ name, url }) => ({
			subject: 'Reset your password',
			title: html`Reset your password`,
			body: html`<p>Hi ${name},</p><p><a href="${url}">Choose a new password.</a> This link expires soon.</p>`,
			text: `Hi ${name},\n\nReset your password: ${url}`,
		}),
		de: ({ name, url }) => ({
			subject: 'Setze dein Passwort zurück',
			title: html`Setze dein Passwort zurück`,
			body: html`<p>Hallo ${name},</p><p><a href="${url}">Wähle ein neues Passwort.</a> Dieser Link läuft bald ab.</p>`,
			text: `Hallo ${name},\n\nSetze dein Passwort zurück: ${url}`,
		}),
	}),
	/** Sent to the *current* address so the owner approves the change. */
	changeEmailConfirmation: defineTemplate<Link & { newEmail: string }>({
		en: ({ name, newEmail, url }) => ({
			subject: 'Confirm your new email address',
			title: html`Confirm your new email address`,
			body: html`<p>Hi ${name},</p><p>You asked to change your sign-in email to <strong>${newEmail}</strong>.</p><p><a href="${url}">Confirm the change.</a> If this wasn't you, ignore this email and consider changing your password.</p>`,
			text: `Hi ${name},\n\nConfirm changing your email to ${newEmail}: ${url}\n\nIf this wasn't you, ignore this email.`,
		}),
		de: ({ name, newEmail, url }) => ({
			subject: 'Bestätige deine neue E-Mail-Adresse',
			title: html`Bestätige deine neue E-Mail-Adresse`,
			body: html`<p>Hallo ${name},</p><p>Du möchtest deine Anmelde-E-Mail-Adresse in <strong>${newEmail}</strong> ändern.</p><p><a href="${url}">Änderung bestätigen.</a> Wenn du das nicht warst, ignoriere diese E-Mail und ändere am besten dein Passwort.</p>`,
			text: `Hallo ${name},\n\nBestätige die Änderung deiner E-Mail-Adresse in ${newEmail}: ${url}\n\nWenn du das nicht warst, ignoriere diese E-Mail.`,
		}),
	}),
	deleteAccount: defineTemplate<Link>({
		en: ({ name, url }) => ({
			subject: 'Confirm account deletion',
			title: html`Delete your account`,
			body: html`<p>Hi ${name},</p><p>This will permanently delete your account and everything in it.</p><p><a href="${url}">Yes, delete my account.</a> If this wasn't you, ignore this email.</p>`,
			text: `Hi ${name},\n\nConfirm deleting your account: ${url}\n\nIf this wasn't you, ignore this email.`,
		}),
		de: ({ name, url }) => ({
			subject: 'Bestätige die Löschung deines Kontos',
			title: html`Konto löschen`,
			body: html`<p>Hallo ${name},</p><p>Damit werden dein Konto und alles darin endgültig gelöscht.</p><p><a href="${url}">Ja, mein Konto löschen.</a> Wenn du das nicht warst, ignoriere diese E-Mail.</p>`,
			text: `Hallo ${name},\n\nBestätige die Löschung deines Kontos: ${url}\n\nWenn du das nicht warst, ignoriere diese E-Mail.`,
		}),
	}),
	/**
	 * Public contact / waitlist form → the operator (`CONTACT_EMAIL`), reply-to set to the sender.
	 * The operator reads it, so it goes out in `DEFAULT_EMAIL_LOCALE` whatever the sender's language.
	 */
	contactMessage: defineTemplate<{ name?: string; email: string; message: string }>({
		en: ({ name, email, message }) => {
			const from = name ? `${name} <${email}>` : email;
			return {
				subject: `New message from ${from}`,
				title: html`New message from the website`,
				body: html`<p><strong>From:</strong> ${from}</p><p style="white-space:pre-wrap">${message}</p>`,
				text: `From: ${from}\n\n${message}`,
			};
		},
		de: ({ name, email, message }) => {
			const from = name ? `${name} <${email}>` : email;
			return {
				subject: `Neue Nachricht von ${from}`,
				title: html`Neue Nachricht über die Website`,
				body: html`<p><strong>Von:</strong> ${from}</p><p style="white-space:pre-wrap">${message}</p>`,
				text: `Von: ${from}\n\n${message}`,
			};
		},
	}),
};
