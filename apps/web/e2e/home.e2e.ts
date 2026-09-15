import { expect, test } from '@playwright/test';

/**
 * `/` is a doorway, not a page (`src/routes/+page.ts`): apps/site is the public landing, so the
 * app's own root hands the visitor straight to the shell, whose guard picks the workspace or the
 * sign-in form. Asserted without following the redirect, because the e2e web server has no API,
 * so `/app` answers 503 here instead of going on to `/login`.
 */
test('the app root is a redirect into the shell, not a second landing page', async ({
	request,
}) => {
	const response = await request.get('/', { maxRedirects: 0 });
	expect(response.status()).toBe(307);
	expect(response.headers().location).toBe('/app');
});
