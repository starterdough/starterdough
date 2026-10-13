import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { EmailMessage } from '@repo/email';

/**
 * The emails Better Auth sends, through the real API against real PostgreSQL: each is written in the
 * language of the request that asked for it, which the web app sends as `Accept-Language`. Run it
 * against a migrated database you can throw away:
 * `DATABASE_URL=… RUN_EMAIL_DB_TESTS=1 bun test apps/api/src/email-locale.db.test.ts`.
 * Opt-in because the API's test preload sets a placeholder `DATABASE_URL` for every test file.
 */
const enabled = Boolean(process.env.DATABASE_URL && process.env.RUN_EMAIL_DB_TESTS === '1');
if (enabled) process.env.SKIP_ENV_VALIDATION = '1';

(enabled ? describe : describe.skip)('email in the language of the request', () => {
	let database: typeof import('@repo/db');
	let emailModule: typeof import('@repo/email');
	let app: typeof import('./app').app;
	const sent: EmailMessage[] = [];
	const prefix = `email-locale-${crypto.randomUUID().slice(0, 8)}`;
	const addresses: string[] = [];
	let restoreSend = () => {};

	beforeAll(async () => {
		emailModule = await import('@repo/email');
		// Captured, never printed: the bodies carry live verification and reset links.
		const send = spyOn(emailModule.email, 'send').mockImplementation(async (message) => {
			sent.push(message);
			return { id: `email-locale-${sent.length}` };
		});
		restoreSend = () => send.mockRestore();
		database = await import('@repo/db');
		app = (await import('./app')).app;
	});

	afterAll(async () => {
		restoreSend();
		if (!database || addresses.length === 0) return;
		const { db, inArray, user, verification } = database;
		const users = await db.select({ id: user.id }).from(user).where(inArray(user.email, addresses));
		const ids = users.map((row) => row.id);
		if (ids.length > 0) {
			// A reset token is a `verification` row keyed by the user's id, with no foreign key.
			await db.delete(verification).where(inArray(verification.value, ids));
			await db.delete(user).where(inArray(user.id, ids));
		}
	});

	async function post(path: string, body: unknown, acceptLanguage?: string): Promise<Response> {
		const headers = new Headers({ 'content-type': 'application/json' });
		if (acceptLanguage) headers.set('accept-language', acceptLanguage);
		return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
	}

	async function signUp(label: string, acceptLanguage?: string): Promise<string> {
		const address = `${prefix}-${label}@example.test`;
		addresses.push(address);
		const response = await post(
			'/api/auth/sign-up/email',
			{ email: address, name: `${label} customer`, password: 'correct-horse-12345' },
			acceptLanguage,
		);
		expect(response.status).toBe(200);
		return address;
	}

	function lastTo(address: string): EmailMessage {
		const message = sent.findLast((candidate) => candidate.to === address);
		if (!message) throw new Error(`no email was sent to ${address}`);
		return message;
	}

	it('sends the verification email in German to someone signing up in German', async () => {
		const address = await signUp('de', 'de');
		const message = lastTo(address);
		expect(message.subject).toBe('Bestätige deine E-Mail-Adresse');
		expect(message.html).toContain('<html lang="de">');
		expect(message.text).toContain('/verify-email?token=');
	});

	it('sends it in English without a language, or with none the kit writes', async () => {
		expect(lastTo(await signUp('none')).subject).toBe('Verify your email');
		expect(lastTo(await signUp('fr', 'fr-FR, ja;q=0.8')).subject).toBe('Verify your email');
	});

	it('follows the request, not the account: a reset asked for in German is German', async () => {
		const address = await signUp('reset');
		const response = await post('/api/auth/request-password-reset', { email: address }, 'de-AT');
		expect(response.status).toBe(200);
		const message = lastTo(address);
		expect(message.subject).toBe('Setze dein Passwort zurück');
		expect(message.text).toContain('/reset-password/');
	});
});
