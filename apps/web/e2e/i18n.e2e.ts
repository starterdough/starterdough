import { expect, test } from '@playwright/test';

/**
 * Locale resolution end to end (Paraglide: cookie → Accept-Language → `en`), on pages that render
 * without an API. Text assertions use messages the lead owns (`common_*`), so they hold whatever
 * the page-specific copy says.
 */

test('defaults to English and marks the document', async ({ page }) => {
	await page.goto('/login');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
	await expect(page.getByRole('link', { name: 'Skip to content' })).toHaveCount(1);
});

test.describe('browser language', () => {
	test.use({ locale: 'de-DE' });

	test('Accept-Language picks German on the first request', async ({ page }) => {
		await page.goto('/login');
		await expect(page.locator('html')).toHaveAttribute('lang', 'de');
		await expect(page.getByRole('link', { name: 'Zum Inhalt springen' })).toHaveCount(1);
		await expect(page.getByText('Skip to content')).toHaveCount(0);
	});

	test('an explicit choice (cookie) beats the browser language', async ({ page, context }) => {
		await context.addCookies([
			{ name: 'PARAGLIDE_LOCALE', value: 'en', domain: 'localhost', path: '/' },
		]);
		await page.goto('/login');
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
		await expect(page.getByRole('link', { name: 'Skip to content' })).toHaveCount(1);
	});
});

test('the switcher persists the choice and reloads in the new language', async ({
	page,
	context,
}) => {
	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');

	await page.getByRole('button', { name: /^Language: / }).click();
	await page.getByRole('menuitemradio', { name: 'Deutsch' }).click();

	await expect(page.locator('html')).toHaveAttribute('lang', 'de');
	await expect(page.getByRole('link', { name: 'App öffnen' })).toBeVisible();
	const cookie = (await context.cookies()).find((c) => c.name === 'PARAGLIDE_LOCALE');
	expect(cookie?.value).toBe('de');

	// Survives navigation: the cookie is read again by the server on the next document request.
	await page.goto('/offline');
	await expect(page.locator('html')).toHaveAttribute('lang', 'de');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Du bist offline');
});
