import { ORPCError } from '@orpc/server';
import { email, templates } from '@repo/email';
import { env } from '@repo/env';
import { os } from './base';

/**
 * `contact.send`: the marketing site's contact / waitlist form. Public, throttled hard in
 * app.ts (a handful per hour per IP on top of the general limiter), no database: the message is
 * emailed to `CONTACT_EMAIL` with the sender as reply-to. The console provider prints it, so
 * development needs no configuration; a real provider without a recipient answers 412.
 */
export const contactRouter = {
	send: os.contact.send.handler(async ({ input }) => {
		// Honeypot filled → a bot. Say yes, do nothing.
		if (input.website) return { ok: true as const };

		const to = env.CONTACT_EMAIL ?? (email.name === 'console' ? 'owner@localhost' : null);
		if (!to) throw new ORPCError('PRECONDITION_FAILED');

		await email.send({
			to,
			replyTo: input.email,
			...templates.contactMessage({
				name: input.name,
				email: input.email,
				message: input.message,
			}),
		});
		return { ok: true as const };
	}),
};
