import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSiteEnv } from './load-site-env.mjs';

const originalSiteUrl = process.env.SITE_URL;
const temporaryDirectories: string[] = [];

function appDirectory(files: { env?: string; envLocal?: string }): URL {
	const directory = mkdtempSync(join(tmpdir(), 'starterdough-site-env-'));
	temporaryDirectories.push(directory);
	if (files.env !== undefined) writeFileSync(join(directory, '.env'), files.env);
	if (files.envLocal !== undefined) writeFileSync(join(directory, '.env.local'), files.envLocal);
	return pathToFileURL(join(directory, 'astro.config.mjs'));
}

async function canonicalBuildGuard(configPath: string, initialSiteUrl: string) {
	process.env.SITE_URL = initialSiteUrl;
	const config = (
		await import(`${pathToFileURL(resolve(configPath)).href}?test=${crypto.randomUUID()}`)
	).default;
	const integration = config.integrations.find(
		(candidate: { name: string }) => candidate.name === 'require-canonical-site',
	);
	if (!integration) throw new Error(`${configPath} has no canonical-site build guard`);
	return integration.hooks['astro:config:setup'];
}

afterEach(() => {
	if (originalSiteUrl === undefined) delete process.env.SITE_URL;
	else process.env.SITE_URL = originalSiteUrl;
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('Astro canonical environment loading', () => {
	it('lets each app replace a blank inherited root value with its own origin', () => {
		const site = appDirectory({ env: 'SITE_URL=https://www.customer.test\n' });
		const docs = appDirectory({ env: 'SITE_URL=https://docs.customer.test\n' });

		process.env.SITE_URL = '';
		loadSiteEnv(site);
		expect(process.env.SITE_URL).toBe('https://www.customer.test');

		process.env.SITE_URL = '';
		loadSiteEnv(docs);
		expect(process.env.SITE_URL).toBe('https://docs.customer.test');
	});

	it('falls back to .env when .env.local leaves SITE_URL blank', () => {
		const app = appDirectory({
			envLocal: 'SITE_URL=\n',
			env: 'SITE_URL=https://fallback.customer.test\n',
		});

		process.env.SITE_URL = '';
		loadSiteEnv(app);

		expect(process.env.SITE_URL).toBe('https://fallback.customer.test');
	});

	it('preserves a nonempty explicit environment override', () => {
		const app = appDirectory({
			envLocal: 'SITE_URL=https://local.customer.test\n',
			env: 'SITE_URL=https://file.customer.test\n',
		});

		process.env.SITE_URL = 'https://deploy.customer.test';
		loadSiteEnv(app);

		expect(process.env.SITE_URL).toBe('https://deploy.customer.test');
	});

	it('keeps SITE_URL absent when every source is blank', () => {
		const app = appDirectory({ envLocal: 'SITE_URL=  \n', env: 'SITE_URL=\n' });

		process.env.SITE_URL = '';
		loadSiteEnv(app);

		expect(process.env.SITE_URL).toBeUndefined();
	});

	it('keeps both apps build-blocked when SITE_URL is unset or a placeholder', async () => {
		for (const configPath of ['apps/site/astro.config.mjs', 'apps/docs/astro.config.mjs']) {
			const placeholderGuard = await canonicalBuildGuard(configPath, 'https://example.com');
			expect(() =>
				placeholderGuard({
					command: 'build',
					config: { site: new URL('https://example.com') },
				}),
			).toThrow('SITE_URL is still the placeholder');

			process.env.SITE_URL = '';
			expect(() =>
				placeholderGuard({
					command: 'build',
					config: { site: new URL('http://localhost') },
				}),
			).toThrow('SITE_URL is not set');
		}
	});
});
