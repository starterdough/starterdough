import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';

describe('/ (landing)', () => {
	it('renders the product name and entry points', async () => {
		render(Page);

		await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent('Starterdough');
		await expect.element(page.getByRole('link', { name: 'Open the app' })).toBeInTheDocument();
		await expect.element(page.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
	});
});
