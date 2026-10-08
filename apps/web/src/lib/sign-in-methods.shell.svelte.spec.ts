import { QueryClient } from '@tanstack/svelte-query';
import { readable } from 'svelte/store';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { PageSession } from '#lib/utils/session.js';

/**
 * The static (bearer) build running inside a Tauri shell. Social sign-in would finish in the
 * system browser, passkeys are bound to the web app's hostname, and the second step of a two-factor
 * sign-in, like an admin's way back from impersonating, needs a cookie the shell never gets back,
 * so none of them may be offered as if it worked; `sign-in-methods.web.svelte.spec.ts` pins the web
 * build, where all of them stay. One file per build because `#lib/api.js` answers with build-time
 * constants.
 */
vi.mock('#lib/api.js', () => ({
	SOCIAL_SIGN_IN_AVAILABLE: false,
	PASSKEYS_AVAILABLE: false,
	TWO_FACTOR_SIGN_IN_AVAILABLE: false,
	IMPERSONATION_AVAILABLE: false,
	returnUrl: (path: string) => `https://app.example.com${path}`,
}));

const { listUserPasskeys } = vi.hoisted(() => ({ listUserPasskeys: vi.fn() }));

vi.mock('#lib/auth.js', () => ({
	authClient: {
		useSession: () => readable({ data: null, isPending: false }),
		signIn: { email: vi.fn(), social: vi.fn(), passkey: vi.fn() },
		sendVerificationEmail: vi.fn(),
		admin: { listUsers: vi.fn(), impersonateUser: vi.fn() },
		passkey: {
			listUserPasskeys,
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

/** Someone else's account, as the admin plugin lists it. */
const grace = {
	id: 'user_2',
	email: 'grace@example.com',
	emailVerified: true,
	name: 'Grace',
	image: null,
	role: 'user',
	banned: false,
	createdAt: new Date('2026-09-01T12:00:00Z'),
	updatedAt: new Date('2026-09-01T12:00:00Z'),
};

/** A passkey added in a browser, as the API lists it to the shell. */
const laptop = {
	id: 'passkey_1',
	name: 'Work laptop',
	publicKey: 'key',
	userId: 'user_1',
	credentialID: 'credential_1',
	counter: 0,
	deviceType: 'multiDevice' as const,
	backedUp: true,
	createdAt: new Date('2026-09-01T12:00:00Z'),
};

test('sign-in offers only email and password, even when the API has providers', async () => {
	const screen = await render(LoginPage, {
		params: {},
		data: {
			queryClient: new QueryClient(),
			authConfig: { socialProviders: ['github', 'google'], requireEmailVerification: false },
		},
	});

	await expect.element(screen.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
	await expect
		.element(screen.getByRole('button', { name: 'Continue with GitHub' }))
		.not.toBeInTheDocument();
	await expect
		.element(screen.getByRole('button', { name: 'Continue with Google' }))
		.not.toBeInTheDocument();
	await expect
		.element(screen.getByRole('button', { name: 'Sign in with a passkey' }))
		.not.toBeInTheDocument();
	// An account made with a provider has no password yet: it is told how to get one.
	await expect
		.element(screen.getByText('Signed up with GitHub or Google?', { exact: false }))
		.toBeVisible();
	await expect.element(screen.getByRole('link', { name: 'Forgot password?' })).toBeVisible();
});

test('sign-in mentions no provider when the API has none', async () => {
	const screen = await render(LoginPage, {
		params: {},
		data: {
			queryClient: new QueryClient(),
			authConfig: { socialProviders: [], requireEmailVerification: false },
		},
	});

	await expect.element(screen.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
	await expect
		.element(screen.getByText('Signed up with', { exact: false }))
		.not.toBeInTheDocument();
});

test('security settings keep existing passkeys manageable but send adding one to the web app', async () => {
	const screen = await render(SecurityPage, {
		params: {},
		data: {
			queryClient: new QueryClient(),
			session,
			flags: {},
			passkeys: [laptop],
		},
	});

	await expect.element(screen.getByText('Work laptop')).toBeVisible();
	await expect.element(screen.getByRole('button', { name: 'Rename Work laptop' })).toBeEnabled();
	await expect.element(screen.getByRole('button', { name: 'Remove Work laptop' })).toBeEnabled();
	await expect
		.element(screen.getByText("Passkeys can't be used or added in this app.", { exact: false }))
		.toBeVisible();
	await expect
		.element(screen.getByRole('button', { name: 'Add a passkey' }))
		.not.toBeInTheDocument();
	await expect
		.element(screen.getByRole('textbox', { name: 'Name (optional)' }))
		.not.toBeInTheDocument();
});

test('an empty passkey list does not point at an "Add" form the shell does not have', async () => {
	const screen = await render(SecurityPage, {
		params: {},
		data: {
			queryClient: new QueryClient(),
			session,
			flags: {},
			passkeys: [],
		},
	});

	await expect.element(screen.getByText('No passkeys yet')).toBeVisible();
	await expect
		.element(screen.getByText('Passkeys you add in the web app appear here.'))
		.toBeVisible();
	await expect.element(screen.getByText('Add one below', { exact: false })).not.toBeInTheDocument();
});

test('the two-factor step explains itself instead of taking a code it cannot check', async () => {
	const screen = await render(TwoFactorPage);

	await expect
		.element(screen.getByText("which this app can't finish yet", { exact: false }))
		.toBeVisible();
	await expect.element(screen.getByRole('link', { name: 'Back to sign in' })).toBeVisible();
	await expect.element(screen.getByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
});

test('security settings warn before two-factor locks the account out of the shell', async () => {
	const screen = await render(SecurityPage, {
		params: {},
		data: {
			queryClient: new QueryClient(),
			session,
			flags: {},
			passkeys: [],
		},
	});

	await expect
		.element(screen.getByText('this account can sign in only to the web app', { exact: false }))
		.toBeVisible();
});

test('the admin user list has no Impersonate, which a shell could not undo', async () => {
	const screen = await render(AdminUsersPage, {
		params: {},
		data: {
			queryClient: new QueryClient(),
			session: { ...session, user: { ...session.user, role: 'admin' } },
			users: { users: [grace], total: 1 },
		},
	});

	await expect.element(screen.getByText('grace@example.com')).toBeVisible();
	await expect.element(screen.getByRole('button', { name: 'Revoke sessions' })).toBeEnabled();
	await expect.element(screen.getByRole('button', { name: 'Impersonate' })).not.toBeInTheDocument();
	await expect
		.element(screen.getByText('Impersonating a user works only in the web app', { exact: false }))
		.toBeVisible();
});
