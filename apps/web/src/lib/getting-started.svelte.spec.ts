import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import GettingStarted from '#lib/components/GettingStarted.svelte';
import { accountSteps } from '#lib/home.js';

const { sendVerificationEmail } = vi.hoisted(() => ({ sendVerificationEmail: vi.fn() }));

vi.mock('#lib/api.js', () => ({ returnUrl: (path: string) => `https://app.example.com${path}` }));
vi.mock('#lib/auth.js', () => ({ authClient: { sendVerificationEmail } }));

const user = { email: 'ada@example.com', emailVerified: true, twoFactorEnabled: false };

test('the checklist shows progress and offers an action for each open step only', async () => {
	const screen = await render(GettingStarted, { steps: accountSteps(user, 0) });

	await expect.element(screen.getByRole('heading', { name: 'Get started' })).toBeVisible();
	await expect.element(screen.getByText('1 of 2 done')).toBeVisible();
	await expect
		.element(screen.getByRole('link', { name: 'Open security settings' }))
		.toHaveAttribute('href', '/app/settings/security');
	// The verified address is done: nothing to resend.
	expect(screen.getByRole('button', { name: 'Resend the link' }).elements()).toHaveLength(0);
	await expect.element(screen.getByText('Verify your email address (done)')).toBeInTheDocument();
});

test('an unverified address gets its link again from the list itself', async () => {
	sendVerificationEmail.mockReset();
	sendVerificationEmail.mockResolvedValueOnce({ data: { status: true }, error: null });
	const screen = await render(GettingStarted, {
		steps: accountSteps({ ...user, emailVerified: false }, 1),
	});

	await expect.element(screen.getByText('1 of 2 done')).toBeVisible();
	// The settings page cannot send it, so no link leads there.
	expect(screen.getByRole('link').elements()).toHaveLength(0);
	await screen.getByRole('button', { name: 'Resend the link' }).click();

	await expect.element(screen.getByRole('status')).toHaveTextContent('Sent. Check your inbox.');
	expect(sendVerificationEmail).toHaveBeenCalledWith({
		email: 'ada@example.com',
		callbackURL: 'https://app.example.com/verify-email',
	});
});
