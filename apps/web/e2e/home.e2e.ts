import { expect, test } from '@playwright/test';

test('landing page renders and links to the app', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Starterdough');
	await expect(page.getByRole('link', { name: 'Open the app' })).toHaveAttribute('href', '/app');
});
