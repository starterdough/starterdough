import { expect, test } from '@playwright/test';

/**
 * The Content-Security-Policy has to hold in a real browser, not only in the config: `script-src`
 * carries no `'unsafe-inline'`, so every inline script the app emits must be one SvelteKit nonces
 * (server-rendered) or hashes (prerendered). A script it does not know about — mode-watcher's theme
 * snippet was one — is refused silently except for a console error, which is what this reads.
 *
 * Same pages as the a11y suite: everything that renders without an API.
 */
const pages = ['/', '/login', '/signup', '/offline'];

for (const path of pages) {
	test(`${path} loads with no CSP violation`, async ({ page }) => {
		const violations: string[] = [];
		page.on('console', (message) => {
			if (/content security policy|refused to (execute|load|apply)/i.test(message.text())) {
				violations.push(message.text());
			}
		});

		const response = await page.goto(path);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

		// Prerendered pages carry the policy in a <meta>, server-rendered ones in the header.
		const header = response?.headers()['content-security-policy'];
		const meta = await page.evaluate(
			() =>
				document
					.querySelector('meta[http-equiv="content-security-policy"]')
					?.getAttribute('content') ?? null,
		);
		const policy = header ?? meta ?? '';
		expect(policy, 'a policy is served').toContain('script-src');
		expect(policy, "no 'unsafe-inline' in script-src").not.toMatch(
			/script-src[^;]*'unsafe-inline'/,
		);
		expect(violations, violations.join('\n')).toEqual([]);
	});
}
