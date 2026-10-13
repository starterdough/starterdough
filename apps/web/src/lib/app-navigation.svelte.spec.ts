import { QueryClient } from '@tanstack/svelte-query';
import { createRawSnippet } from 'svelte';
import { readable } from 'svelte/store';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { PageSession } from '#lib/utils/session.js';

/**
 * A product's links in `#lib/product.ts` reach the navigation and the command palette, before
 * Settings, without a product editing the shell. Kit releases never change that file, so this is
 * the wiring the promise rests on.
 */
vi.mock('#lib/product.js', async () => ({
	productNavLinks: [
		{
			href: '/app/reports',
			label: () => 'Reports',
			icon: (await import('@lucide/svelte/icons/file-text')).default,
			keywords: ['quarterly'],
		},
	],
}));

vi.mock('$app/navigation', () => ({ goto: vi.fn(), refreshAll: vi.fn(), afterNavigate: vi.fn() }));

vi.mock('#lib/api.js', () => ({
	DEMO_CTA_URL: null,
	DEMO_MODE: false,
	IMPERSONATION_AVAILABLE: true,
	returnUrl: (path: string) => `https://app.example.com${path}`,
}));

vi.mock('#lib/pwa.svelte.js', () => ({
	isTauri: false,
	pwa: { updateAvailable: false, canInstall: false, install: vi.fn(), clearCaches: vi.fn() },
}));

vi.mock('#lib/analytics.svelte.js', () => ({
	analytics: { identify: vi.fn(), signOut: vi.fn() },
}));

vi.mock('#lib/token-store.js', () => ({
	usesBearerAuth: false,
	tokenStore: { get: () => null, set: vi.fn(), clear: vi.fn() },
}));

vi.mock('#lib/auth.js', () => ({
	authClient: {
		useSession: () => readable({ data: null, isPending: true }),
		signOut: vi.fn(),
		sendVerificationEmail: vi.fn(),
	},
}));

const session: PageSession = {
	user: {
		id: 'user_1',
		email: 'ada@example.com',
		emailVerified: true,
		role: 'user',
		name: 'Ada',
		image: null,
		twoFactorEnabled: false,
	},
	session: { id: 'session_1', activeOrganizationId: null, impersonatedBy: null },
};

import Layout from '../routes/(app)/app/+layout.svelte';

function renderShell() {
	return render(Layout, {
		params: {},
		data: {
			queryClient: new QueryClient(),
			session,
			flags: {},
		},
		children: createRawSnippet(() => ({ render: () => '<p>Home</p>' })),
	});
}

test('a product link is in the navigation, just before Settings', async () => {
	const screen = await renderShell();
	await screen.getByRole('button', { name: 'Open navigation' }).click();

	// The menu's copy: the sidebar's is the same snippet, hidden on a narrow screen.
	const navigation = screen.getByRole('dialog').getByRole('navigation', { name: 'Primary' });
	await expect.element(navigation.getByRole('link', { name: 'Reports' })).toBeVisible();
	await expect
		.element(navigation.getByRole('link', { name: 'Reports' }))
		.toHaveAttribute('href', '/app/reports');
	const names = navigation
		.getByRole('link')
		.elements()
		.map((link) => link.textContent?.trim());
	expect(names.indexOf('Reports')).toBe(names.indexOf('Settings') - 1);
});

test('a product link is in the command palette, found by its keywords too', async () => {
	const screen = await renderShell();
	await screen.getByRole('button', { name: 'Search', exact: true }).click();

	const search = screen.getByRole('combobox');
	await expect.element(screen.getByRole('option', { name: 'Reports' })).toBeVisible();
	await search.fill('quarterly');
	await expect.element(screen.getByRole('option', { name: 'Reports' })).toBeVisible();
	await expect.element(screen.getByRole('option', { name: 'Settings' })).not.toBeInTheDocument();
});
