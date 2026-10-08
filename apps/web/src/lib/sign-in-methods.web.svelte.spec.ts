import { QueryClient } from '@tanstack/svelte-query';
import { readable } from 'svelte/store';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { PageSession } from '#lib/utils/session.js';

/**
 * A web (cookie) build: every sign-in method the API reports is offered, and admins can
 * impersonate. The counterpart of `sign-in-methods.shell.svelte.spec.ts`, so hiding them in the
 * shells cannot hide them here too.
 */
vi.mock('#lib/api.js', () => ({
	SOCIAL_SIGN_IN_AVAILABLE: true,
	PASSKEYS_AVAILABLE: true,
	TWO_FACTOR_SIGN_IN_AVAILABLE: true,
	IMPERSONATION_AVAILABLE: true,
	returnUrl: (path: string) => `https://app.example.com${path}`,
}));

vi.mock('#lib/auth.js', () => ({
	authClient: {
		useSession: () => readable({ data: null, isPending: false }),
		signIn: { email: vi.fn(), social: vi.fn(), passkey: vi.fn() },
		sendVerificationEmail: vi.fn(),
		admin: { listUsers: vi.fn(), impersonateUser: vi.fn() },
		passkey: {
			listUserPasskeys: vi.fn(),
			addPasskey: vi.fn(),
			updatePasskey: vi.fn(),
			deletePasskey: vi.fn(),
		},
	},
}));

import AdminUsersPage from '../routes/(admin)/admin/users/+page.svelte';
import SecurityPage from '../routes/(app)/app/settings/security/+page.svelte';
import LoginPage from '../routes/(auth)/login/+page.svelte';
import TwoFactorPage from '../routes/(auth)/two-factor/+page.svelte';

const session: PageSession = {
	user: {
		id: 'user_1',
		email: 'ada@example.com',
		emailVerified: true,
		role: null,
		name: 'Ada',
		image: null,
		twoFactorEnabled: false,
	},
	session: { id: 'session_1', activeOrganizationId: null, impersonatedBy: null },
};

test('sign-in offers the configured providers and passkeys next to the password form', async () => {
	const screen = await render(LoginPage, {
		params: {},
		data: {
			queryClient: new QueryClient(),
			authConfig: { socialProviders: ['github', 'google'], requireEmailVerification: false },
		},
	});

	await expect.element(screen.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
	await expect.element(screen.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
	await expect
		.element(screen.getByRole('button', { name: 'Sign in with a passkey' }))
		.toBeVisible();
	await expect
		.element(screen.getByText('Signed up with', { exact: false }))
		.not.toBeInTheDocument();
});

test('security settings offer to add a passkey', async () => {
	const screen = await render(SecurityPage, {
		params: {},
		data: {
			queryClient: new QueryClient(),
			session,
			flags: {},
			passkeys: [],
		},
	});

	await expect.element(screen.getByRole('button', { name: 'Add a passkey' })).toBeVisible();
	await expect.element(screen.getByRole('textbox', { name: 'Name (optional)' })).toBeEnabled();
	await expect.element(screen.getByText('Add one below', { exact: false })).toBeVisible();
	await expect
		.element(screen.getByText("Passkeys can't be used or added in this app.", { exact: false }))
		.not.toBeInTheDocument();
	await expect
		.element(screen.getByText('this account can sign in only to the web app', { exact: false }))
		.not.toBeInTheDocument();
});

test('the two-factor step takes a code', async () => {
	const screen = await render(TwoFactorPage);

	await expect.element(screen.getByRole('textbox', { name: 'Verification code' })).toBeVisible();
	await expect.element(screen.getByRole('button', { name: 'Verify' })).toBeVisible();
});

test('the admin user list offers Impersonate', async () => {
	const screen = await render(AdminUsersPage, {
		params: {},
		data: {
			queryClient: new QueryClient(),
			session: { ...session, user: { ...session.user, role: 'admin' } },
			users: {
				users: [
					{
						id: 'user_2',
						email: 'grace@example.com',
						emailVerified: true,
						name: 'Grace',
						image: null,
						role: 'user',
						banned: false,
						createdAt: new Date('2026-09-01T12:00:00Z'),
						updatedAt: new Date('2026-09-01T12:00:00Z'),
					},
				],
				total: 1,
			},
		},
	});

	await expect.element(screen.getByRole('button', { name: 'Impersonate' })).toBeEnabled();
	await expect
		.element(screen.getByText('Impersonating a user works only in the web app', { exact: false }))
		.not.toBeInTheDocument();
});
