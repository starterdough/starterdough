import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/api.js', () => ({ DEMO_CTA_URL: null }));

import DemoBanner from './components/DemoBanner.svelte';

test('the banner links to the page the deployment names', async () => {
	const screen = await render(DemoBanner, { href: 'https://acme.test/pricing' });
	await expect
		.element(screen.getByRole('link', { name: 'Buy Starterdough' }))
		.toHaveAttribute('href', 'https://acme.test/pricing');
});

test('without PUBLIC_DEMO_CTA_URL the banner says it is a demo and links nowhere', async () => {
	const screen = await render(DemoBanner);
	await expect.element(screen.getByText('This is a live demo.', { exact: false })).toBeVisible();
	expect(screen.container.querySelector('a')).toBeNull();
});
