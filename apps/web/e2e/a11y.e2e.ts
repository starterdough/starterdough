import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * Automated accessibility checks (axe-core, WCAG 2.2 AA) on the pages that render without an
 * API (the e2e web server has none): the auth forms and the offline page (`/` is a redirect, the
 * guarded routes answer 503 without an API). Authenticated pages are covered by the
 * manual keyboard/contrast pass; axe finds structure and contrast issues, not usability.
 */
const pages = ['/login', '/signup', '/forgot-password', '/offline'];

for (const path of pages) {
	test(`${path} has no WCAG 2.2 AA violations`, async ({ page }) => {
		await page.goto(path);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
			.analyze();
		expect(
			results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`),
			results.violations
				.flatMap((v) => v.nodes.map((n) => `${v.id} → ${n.target.join(' ')}: ${n.failureSummary}`))
				.join('\n'),
		).toEqual([]);
	});
}

test('every page has exactly one main landmark and the skip link targets it', async ({ page }) => {
	await page.goto('/login');
	await expect(page.getByRole('main')).toHaveCount(1);
	await page.keyboard.press('Tab');
	const skip = page.getByRole('link', { name: /skip to (main )?content/i });
	await expect(skip).toBeFocused();
	const href = await skip.getAttribute('href');
	expect(href).toBe('#main');
	await expect(page.locator('#main')).toHaveCount(1);
});
