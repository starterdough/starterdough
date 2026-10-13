import { QueryClient } from '@tanstack/svelte-query';
import { createRawSnippet } from 'svelte';
import { readable } from 'svelte/store';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { PageSession } from '#lib/utils/session.js';

/**
 * An admin who is impersonating someone inside a Tauri shell. A shell no longer offers to start
 * (`IMPERSONATION_AVAILABLE`), but an older build may have. The API keeps the admin's own session
 * in an `admin_session` cookie the shell never gets back, so "Stop impersonating" fails there.
 * The layout must not leave the admin acting as someone else with only an error toast: it signs
 * this session out, and the admin signs in again as themselves.
 */
const { goto, stopImpersonating, signOut, clearToken } = vi.hoisted(() => ({
	goto: vi.fn(),
	stopImpersonating: vi.fn(),
	signOut: vi.fn(),
	clearToken: vi.fn(),
}));

vi.mock('$app/navigation', () => ({ goto, refreshAll: vi.fn(), afterNavigate: vi.fn() }));

vi.mock('#lib/api.js', () => ({
	DEMO_CTA_URL: null,
	DEMO_MODE: false,
	IMPERSONATION_AVAILABLE: false,
	returnUrl: (path: string) => `https://app.example.com${path}`,
}));

vi.mock('#lib/pwa.svelte.js', () => ({
	isTauri: true,
	pwa: { updateAvailable: false, canInstall: false, install: vi.fn(), clearCaches: vi.fn() },
}));

vi.mock('#lib/analytics.svelte.js', () => ({
	analytics: { identify: vi.fn(), signOut: vi.fn() },
}));

vi.mock('#lib/token-store.js', () => ({
	usesBearerAuth: true,
	tokenStore: { get: () => 'impersonation-token', set: vi.fn(), clear: clearToken },
}));

// The palette fetches through TanStack Query; it plays no part here.
vi.mock('#lib/components/CommandPalette.svelte', () => ({ default: () => {} }));

const session: PageSession = {
	user: {
		id: 'user_2',
		email: 'grace@example.com',
		emailVerified: true,
		role: 'user',
		name: 'Grace',
		image: null,
		twoFactorEnabled: false,
	},
	session: { id: 'session_2', activeOrganizationId: null, impersonatedBy: 'admin_1' },
};

vi.mock('#lib/auth.js', () => ({
	authClient: {
		useSession: () => readable({ data: null, isPending: true }),
		admin: { stopImpersonating },
		signOut,
		sendVerificationEmail: vi.fn(),
	},
}));

import Layout from '../routes/(app)/app/+layout.svelte';

test('a stop that cannot finish in the shell signs the impersonation out', async () => {
	stopImpersonating.mockResolvedValueOnce({
		data: null,
		error: { status: 500, message: 'Failed to find admin session' },
	});
	signOut.mockResolvedValueOnce({ data: { success: true }, error: null });
	const screen = await render(Layout, {
		params: {},
		data: {
			queryClient: new QueryClient(),
			session,
			flags: {},
		},
		children: createRawSnippet(() => ({ render: () => '<p>Workspace</p>' })),
	});

	await expect
		.element(screen.getByText('You are signed in as grace@example.com', { exact: false }))
		.toBeVisible();
	await screen.getByRole('button', { name: 'Stop impersonating' }).click();

	await expect.poll(() => goto.mock.calls).toContainEqual(['/login']);
	expect(signOut).toHaveBeenCalledOnce();
	expect(clearToken).toHaveBeenCalledOnce();
});
