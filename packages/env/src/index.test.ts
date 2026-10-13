import { describe, expect, it } from 'bun:test';

// `createEnv` validates at import time; this suite is about the rules, not this machine's `.env`.
process.env.SKIP_ENV_VALIDATION ??= '1';
const {
	configurationIssues,
	cookieDomainIssues,
	emailFromDomain,
	normalizeOrigin,
	placeholderSecrets,
	env,
} = await import('./index');

/** A production environment that satisfies the schema; the tests vary one value at a time. */
const production = {
	NODE_ENV: 'production',
	DATABASE_URL: 'postgres://starterdough:S3cr3t-generated@db:5432/starterdough',
	BETTER_AUTH_SECRET: 'a'.repeat(48),
	RESEND_API_KEY: 're_live_abcdef123456',
	EMAIL_FROM: 'Starterdough <noreply@starterdough-kit.dev>',
};

const names = (issues: { name: string }[]) => issues.map((issue) => issue.name).sort();

describe('placeholderSecrets', () => {
	it('refuses the example secret in production, naming the variable', () => {
		const found = placeholderSecrets({
			...production,
			BETTER_AUTH_SECRET: 'change-me-to-a-random-string-of-at-least-32-characters',
		});
		expect(found.map((issue) => issue.name)).toEqual(['BETTER_AUTH_SECRET']);
		expect(found[0]?.message).toContain('BETTER_AUTH_SECRET');
	});

	it('is case-insensitive and covers every secret the schema knows', () => {
		const found = placeholderSecrets({
			...production,
			GITHUB_CLIENT_SECRET: 'CHANGE-ME',
			RESEND_API_KEY: 'Change-Me-Too',
		});
		expect(names(found)).toEqual(['GITHUB_CLIENT_SECRET', 'RESEND_API_KEY']);
	});

	it('refuses the development database password inside DATABASE_URL', () => {
		for (const url of [
			'postgres://starterdough:starterdough@db:5432/starterdough',
			'postgres://postgres:postgres@db:5432/starterdough',
			'postgres://starterdough:change-me@db:5432/starterdough',
		]) {
			const found = placeholderSecrets({ ...production, DATABASE_URL: url });
			expect(found.map((issue) => issue.name)).toEqual(['DATABASE_URL']);
		}
	});

	it('accepts a real production environment', () => {
		expect(configurationIssues(production)).toEqual([]);
		// A URL without a password (peer/socket auth, or a password from the environment) is fine.
		expect(
			configurationIssues({
				...production,
				DATABASE_URL: 'postgres://starterdough@db:5432/starterdough',
			}),
		).toEqual([]);
	});

	it('leaves development and test alone: the placeholders are what makes them work', () => {
		const example = { ...production, BETTER_AUTH_SECRET: 'change-me' };
		expect(placeholderSecrets({ ...example, NODE_ENV: 'development' })).toEqual([]);
		expect(placeholderSecrets({ ...example, NODE_ENV: 'test' })).toEqual([]);
	});
});

describe('production requirements', () => {
	it('refuses a production deploy with no email provider', () => {
		expect(names(configurationIssues({ ...production, RESEND_API_KEY: '' }))).toEqual([
			'RESEND_API_KEY',
		]);
	});

	it('lets a public demo run without a provider once verification is off', () => {
		const demo = { ...production, RESEND_API_KEY: '', PUBLIC_DEMO_MODE: 'true' };
		expect(names(configurationIssues(demo))).toEqual(['REQUIRE_EMAIL_VERIFICATION']);
		expect(configurationIssues({ ...demo, REQUIRE_EMAIL_VERIFICATION: 'false' })).toEqual([]);
		// The schema hands the rules booleans, not strings.
		expect(
			configurationIssues({ ...demo, PUBLIC_DEMO_MODE: true, REQUIRE_EMAIL_VERIFICATION: false }),
		).toEqual([]);
	});

	it('refuses an EMAIL_FROM no provider will send from', () => {
		for (const from of [
			'Starterdough <noreply@localhost>',
			'noreply@example.com',
			'noreply@test',
			'Starterdough <noreply@localhost.>',
			'starterdough-kit.dev',
		]) {
			expect(names(configurationIssues({ ...production, EMAIL_FROM: from }))).toEqual([
				'EMAIL_FROM',
			]);
		}
		expect(
			configurationIssues({ ...production, EMAIL_FROM: 'noreply@starterdough-kit.dev' }),
		).toEqual([]);
	});

	it('applies none of it outside production', () => {
		expect(
			configurationIssues({
				NODE_ENV: 'development',
				EMAIL_FROM: 'Starterdough <noreply@localhost>',
			}),
		).toEqual([]);
	});

	it('reads the domain out of both EMAIL_FROM spellings', () => {
		expect(emailFromDomain('Starterdough <noreply@Example.COM>')).toBe('example.com');
		expect(emailFromDomain('noreply@example.com')).toBe('example.com');
		expect(emailFromDomain('noreply@')).toBeUndefined();
		expect(emailFromDomain('nobody')).toBeUndefined();
	});
});

describe('cookieDomainIssues', () => {
	it('accepts a parent domain both origins sit under', () => {
		expect(
			cookieDomainIssues({
				COOKIE_DOMAIN: '.example.com',
				WEB_URL: 'https://app.example.com',
				API_URL: 'https://api.example.com',
			}),
		).toEqual([]);
		// The apex itself counts as under it, and so does a single-origin localhost setup.
		expect(
			cookieDomainIssues({
				COOKIE_DOMAIN: 'example.com',
				WEB_URL: 'https://example.com',
				API_URL: 'https://example.com/api',
			}),
		).toEqual([]);
	});

	it('names the origin that would lose its session cookie', () => {
		const found = cookieDomainIssues({
			COOKIE_DOMAIN: '.example.com',
			WEB_URL: 'https://app.example.com',
			API_URL: 'https://api.other.com',
		});
		expect(found).toHaveLength(1);
		expect(found[0]?.name).toBe('COOKIE_DOMAIN');
		expect(found[0]?.message).toContain('API_URL');
		// A near-miss that only shares a suffix is still a miss.
		expect(
			cookieDomainIssues({
				COOKIE_DOMAIN: '.example.com',
				WEB_URL: 'https://notexample.com',
				API_URL: 'https://api.example.com',
			}),
		).toHaveLength(1);
	});

	it('is silent when COOKIE_DOMAIN is unset (single-origin deployments)', () => {
		expect(cookieDomainIssues({ WEB_URL: 'https://a.com', API_URL: 'https://b.com' })).toEqual([]);
	});
});

describe('normalizeOrigin', () => {
	it('spells an http(s) origin the way a browser sends it in `Origin`', () => {
		expect(normalizeOrigin('https://app.example.com/')).toBe('https://app.example.com');
		expect(normalizeOrigin('https://App.Example.COM')).toBe('https://app.example.com');
		expect(normalizeOrigin('https://app.example.com:443')).toBe('https://app.example.com');
		expect(normalizeOrigin('HTTP://localhost:5173/app/')).toBe('http://localhost:5173');
		expect(normalizeOrigin('http://tauri.localhost')).toBe('http://tauri.localhost');
		expect(normalizeOrigin('https://bücher.example')).toBe('https://xn--bcher-kva.example');
	});

	it('lower-cases only the scheme and authority of any other scheme, never turning it into `null`', () => {
		// `new URL('tauri://localhost').origin` is the string 'null', which is what a sandboxed frame
		// or a `data:` page sends: trusting it would trust every such page.
		expect(normalizeOrigin('tauri://localhost')).toBe('tauri://localhost');
		expect(normalizeOrigin('Capacitor://LocalHost')).toBe('capacitor://localhost');
		expect(normalizeOrigin('https://')).toBe('https://');
		// Better Auth compares a custom scheme's path case-sensitively, so it stays as written.
		expect(normalizeOrigin('myapp://auth/Callback')).toBe('myapp://auth/Callback');
		expect(normalizeOrigin('MyApp://Auth/Callback')).toBe('myapp://auth/Callback');
		expect(normalizeOrigin('MyApp://Auth#Frag')).toBe('myapp://auth#Frag');
	});

	it('keeps a Better Auth wildcard pattern exactly as written', () => {
		// `URL` reads `?` as the start of a query: `https://pr-???.example.com` became `https://pr-`.
		expect(normalizeOrigin('https://pr-???.example.com')).toBe('https://pr-???.example.com');
		expect(normalizeOrigin('https://*.Example.com/')).toBe('https://*.Example.com/');
		expect(normalizeOrigin('*.example.com')).toBe('*.example.com');
		expect(normalizeOrigin('MyApp://*')).toBe('MyApp://*');
	});

	it('keeps a value without an authority exactly as written', () => {
		// An Android app's passkey origin: the key hash is base64url, so case is part of it.
		const android = 'android:apk-key-hash:sYUC8p5I9cXh-Kw_2bOq7lGzRm3sTUVWXYZabcdEfGh';
		expect(normalizeOrigin(android)).toBe(android);
		expect(normalizeOrigin('ios-app:Example')).toBe('ios-app:Example');
	});
});

describe('SKIP_ENV_VALIDATION', () => {
	it('still parses, so transformed values keep their real types', () => {
		// The whole point: readers must not have to defend against `'true'` or a string port.
		expect(typeof env.TRUST_PROXY).toBe('boolean');
		expect(env.PUBLIC_DEMO_MODE).toBe(false);
		expect(typeof env.PORT).toBe('number');
	});
});

/** The refusal has to reach the caller: `createEnv` runs at import time, so this is a subprocess. */
function importEnv(overrides: Record<string, string>) {
	const result = Bun.spawnSync([process.execPath, '--eval', 'await import("./index.ts")'], {
		cwd: import.meta.dir,
		env: { PATH: process.env.PATH ?? '', ...production, ...overrides },
		stderr: 'pipe',
		stdout: 'pipe',
	});
	return { code: result.exitCode, stderr: result.stderr.toString() };
}

describe('trustedOrigins', () => {
	it('lists each origin once, the way a browser sends it, however the variables spell it', () => {
		const result = Bun.spawnSync(
			[
				process.execPath,
				'--eval',
				'const { trustedOrigins } = await import("./index.ts"); console.log(JSON.stringify(trustedOrigins()))',
			],
			{
				cwd: import.meta.dir,
				env: {
					PATH: process.env.PATH ?? '',
					...production,
					WEB_URL: 'https://App.Example.com:443/',
					TRUSTED_ORIGINS: [
						'https://app.example.com',
						' https://docs.example.com/',
						'tauri://localhost',
						'https://pr-???.example.com',
						'MyApp://auth/Callback',
						'android:apk-key-hash:sYUC8p5I',
					].join(','),
				},
				stderr: 'pipe',
				stdout: 'pipe',
			},
		);
		expect(result.stderr.toString()).toBe('');
		expect(JSON.parse(result.stdout.toString())).toEqual([
			'https://app.example.com',
			'https://docs.example.com',
			'tauri://localhost',
			'https://pr-???.example.com',
			'myapp://auth/Callback',
			'android:apk-key-hash:sYUC8p5I',
		]);
	});
});

describe('env', () => {
	it('fails to load in production when a secret is still the example placeholder', () => {
		const { code, stderr } = importEnv({
			BETTER_AUTH_SECRET: 'change-me-to-a-random-string-of-at-least-32-characters',
		});
		expect(code).not.toBe(0);
		expect(stderr).toContain('BETTER_AUTH_SECRET');
	});

	it('fails to load in production with no email provider configured', () => {
		const { code, stderr } = importEnv({ RESEND_API_KEY: '' });
		expect(code).not.toBe(0);
		expect(stderr).toContain('RESEND_API_KEY');
	});

	it('fails to load when COOKIE_DOMAIN is a URL rather than a hostname', () => {
		const { code, stderr } = importEnv({ COOKIE_DOMAIN: 'https://example.com' });
		expect(code).not.toBe(0);
		expect(stderr).toContain('COOKIE_DOMAIN');
	});

	it('refuses `null` in TRUSTED_ORIGINS, in any spelling, naming the variable', () => {
		for (const value of ['null', 'https://app.example.com, NULL', ' "null" ,tauri://localhost']) {
			const { code, stderr } = importEnv({ TRUSTED_ORIGINS: value });
			expect(code).not.toBe(0);
			expect(stderr).toContain('TRUSTED_ORIGINS');
			expect(stderr).toContain('sandboxed iframes');
		}
	});

	it('refuses `null` in TRUSTED_ORIGINS outside production and under SKIP_ENV_VALIDATION too', () => {
		// The most lenient start there is: no production-only rules and no cross-field rules.
		const { code, stderr } = importEnv({
			NODE_ENV: 'development',
			SKIP_ENV_VALIDATION: '1',
			TRUSTED_ORIGINS: 'null',
		});
		expect(code).not.toBe(0);
		expect(stderr).toContain('TRUSTED_ORIGINS');
		expect(stderr).toContain('sandboxed iframes');
	});

	it('takes a host that only contains the word `null`', () => {
		const { code, stderr } = importEnv({
			TRUSTED_ORIGINS: 'https://null.example.com,https://nullable.dev',
		});
		expect(stderr).toBe('');
		expect(code).toBe(0);
	});

	it('takes the empty SENTRY_DSN row .env.example ships, and refuses one that is not a URL', () => {
		expect(importEnv({ SENTRY_DSN: '', SENTRY_ENVIRONMENT: '' }).code).toBe(0);
		const { code, stderr } = importEnv({ SENTRY_DSN: 'o123.ingest.sentry.io/456' });
		expect(code).not.toBe(0);
		expect(stderr).toContain('SENTRY_DSN');
	});

	it('loads in production with real secrets', () => {
		expect(importEnv({}).code).toBe(0);
	});
});
