import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import type { EmailMessage } from '@repo/email';

// `createEnv` validates at import time; this suite is about which language each email is in.
process.env.SKIP_ENV_VALIDATION ??= '1';
const emailModule = await import('@repo/email');
const { auth } = await import('./server');
const { createAuthClient } = await import('./client');

// Captured, never printed: the callbacks below are handed links that look like live ones.
const sent: EmailMessage[] = [];
const send = spyOn(emailModule.email, 'send').mockImplementation(async (message) => {
	sent.push(message);
	return { id: `email-${sent.length}` };
});
afterAll(() => send.mockRestore());

/** A request carrying the `Accept-Language` the web app's auth client sends. */
function requestIn(language: string): Request {
	return new Request('https://api.example.test/api/auth/x', {
		headers: { 'accept-language': language },
	});
}

const account = { id: 'user-1', name: 'Ada', email: 'ada@example.test' } as never;
const url = 'https://api.example.test/api/auth/x?token=t';

/** The subject of the one email `callback` sends. */
async function subjectOf(callback: () => Promise<void> | undefined): Promise<string | undefined> {
	sent.length = 0;
	await callback();
	expect(sent).toHaveLength(1);
	return sent[0]?.subject;
}

describe('auth email language', () => {
	const { emailAndPassword, emailVerification, user } = auth.options;
	const verify = (request?: Request) =>
		emailVerification?.sendVerificationEmail?.({ user: account, url, token: 't' }, request);

	// The DB suite covers sign-up and reset through the real API; this reaches every callback,
	// including the ones that need a signed-in session to trigger.
	it('writes each account email in the language of the request that asked for it', async () => {
		const german = requestIn('de-AT');
		expect(await subjectOf(() => verify(german))).toBe('Bestätige deine E-Mail-Adresse');
		expect(
			await subjectOf(() =>
				emailAndPassword?.sendResetPassword?.({ user: account, url, token: 't' }, german),
			),
		).toBe('Setze dein Passwort zurück');
		expect(
			await subjectOf(() =>
				user?.changeEmail?.sendChangeEmailConfirmation?.(
					{ user: account, newEmail: 'new@example.test', url, token: 't' },
					german,
				),
			),
		).toBe('Bestätige deine neue E-Mail-Adresse');
		expect(
			await subjectOf(() =>
				user?.deleteUser?.sendDeleteAccountVerification?.(
					{ user: account, url, token: 't' },
					german,
				),
			),
		).toBe('Bestätige die Löschung deines Kontos');
	});

	it('writes English for a language the kit does not write, and without a request', async () => {
		expect(await subjectOf(() => verify(requestIn('fr-FR, ja;q=0.8')))).toBe('Verify your email');
		// `auth.api.*` called on the server (create-admin, seed) hands the callback no request.
		expect(await subjectOf(() => verify())).toBe('Verify your email');
	});
});

describe('auth client language', () => {
	/** The `Accept-Language` of every call a client makes, through a stand-in for `fetch`. */
	function recorder() {
		const languages: (string | null)[] = [];
		const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
			languages.push(new Headers(init?.headers).get('accept-language'));
			return Response.json({ status: true });
		};
		return { fetch, languages };
	}

	it("sends the app's current locale on every auth call", async () => {
		const { fetch, languages } = recorder();
		let locale = 'de';
		const client = createAuthClient({
			baseURL: 'https://api.example.test',
			fetch,
			locale: () => locale,
		});
		await client.requestPasswordReset({ email: 'ada@example.test' });
		// Read per call, so switching the app's language takes effect without a new client.
		locale = 'en';
		await client.getSession();
		expect(languages).toEqual(['de', 'en']);
	});

	it('leaves the header to the browser when it is given no locale', async () => {
		const { fetch, languages } = recorder();
		await createAuthClient({ baseURL: 'https://api.example.test', fetch }).requestPasswordReset({
			email: 'ada@example.test',
		});
		expect(languages).toEqual([null]);
	});
});
