import type { FeatureFlag } from '@repo/api-client';
import { QueryClient } from '@tanstack/svelte-query';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { PageSession } from '$lib/utils/session';

const session: PageSession = {
	user: {
		id: 'admin_1',
		email: 'admin@example.com',
		emailVerified: true,
		role: 'admin',
		name: 'Admin',
		image: null,
		twoFactorEnabled: false,
	},
	session: {
		id: 'session_1',
		activeOrganizationId: null,
		impersonatedBy: null,
	},
};

function flag({
	key,
	description,
	enabled,
}: {
	key: string;
	description?: string;
	enabled?: boolean;
}) {
	return {
		key,
		description: description ?? '',
		enabled: enabled ?? false,
		createdAt: new Date(),
		updatedAt: new Date(),
	} satisfies FeatureFlag;
}

function pageData() {
	return { flags: [], session, queryClient: new QueryClient() };
}

const { upsert } = vi.hoisted(() => ({
	upsert: vi.fn(),
}));

vi.mock('$lib/api', () => ({
	api: {
		admin: {
			flags: {
				list: vi.fn(),
				upsert,
				delete: vi.fn(),
			},
		},
	},
}));

import Page from '../routes/(admin)/admin/flags/+page.svelte';

test('the flag form shows the localized shared-schema error, then submits a valid flag', async () => {
	upsert.mockReset();
	upsert.mockImplementationOnce(flag);
	const screen = await render(Page, { params: {}, data: pageData() });
	const key = screen.getByRole('textbox', { name: 'Key' });

	await key.fill('X');
	await screen.getByRole('button', { name: 'Create flag' }).click();
	await expect.element(screen.getByText('Use at least 2 characters')).toBeVisible();
	await expect.element(key).toHaveAttribute('aria-invalid', 'true');
	expect(upsert).not.toHaveBeenCalled();

	await key.fill('release-notes');
	await screen.getByRole('textbox', { name: 'Description' }).fill('Show release notes.');
	await screen.getByRole('button', { name: 'Create flag' }).click();

	await expect
		.poll(() => upsert.mock.calls)
		.toEqual([[{ key: 'release-notes', description: 'Show release notes.', enabled: false }]]);
	await expect.element(screen.getByText('Flag release-notes created.')).toBeVisible();
	await expect.element(key).toHaveValue('');
});

test('the flag form keeps its inputs when the API rejects a valid submission', async () => {
	upsert.mockReset();
	upsert.mockRejectedValueOnce(new Error('The API is unavailable.'));
	const screen = await render(Page, { params: {}, data: pageData() });
	const key = screen.getByRole('textbox', { name: 'Key' });
	const description = screen.getByRole('textbox', { name: 'Description' });

	await key.fill('release-notes');
	await description.fill('Show release notes.');
	await screen.getByRole('button', { name: 'Create flag' }).click();

	await expect.element(screen.getByText('The API is unavailable.')).toBeVisible();
	await expect.element(key).toHaveValue('release-notes');
	await expect.element(description).toHaveValue('Show release notes.');
});

test('the flag form prevents a second submission while its request is pending', async () => {
	upsert.mockReset();
	let finish: (flag: FeatureFlag) => void = () => {};
	upsert.mockImplementationOnce(
		() =>
			new Promise<FeatureFlag>((resolve) => {
				finish = resolve;
			}),
	);
	const screen = await render(Page, { params: {}, data: pageData() });

	await screen.getByRole('textbox', { name: 'Key' }).fill('release-notes');
	await screen.getByRole('button', { name: 'Create flag' }).click();
	await expect.element(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();

	finish(flag({ key: 'release-notes' }));
	await expect.element(screen.getByText('Flag release-notes created.')).toBeVisible();
});
