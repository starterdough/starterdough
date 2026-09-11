import { describe, expect, it } from 'bun:test';

// `createEnv` validates at import time; this suite is about the rules, not this machine's `.env`.
process.env.SKIP_ENV_VALIDATION ??= '1';
const { configurationIssues, cookieDomainIssues, emailFromDomain, placeholderSecrets, env } =
	await import('./index');

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

describe('SKIP_ENV_VALIDATION', () => {
	it('still parses, so transformed values keep their real types', () => {
		// The whole point: readers must not have to defend against `'true'` or a string port.
		expect(typeof env.TRUST_PROXY).toBe('boolean');
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

	it('loads in production with real secrets', () => {
		expect(importEnv({}).code).toBe(0);
	});
});
