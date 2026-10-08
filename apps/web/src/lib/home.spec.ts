import { describe, expect, it } from 'vitest';

import { accountSteps, greetingName, stepProgress } from './home';

const user = { email: 'ada@example.com', emailVerified: false, twoFactorEnabled: false };

function done(steps: ReturnType<typeof accountSteps>) {
	return Object.fromEntries(steps.map((step) => [step.id, step.done]));
}

describe('getting-started steps', () => {
	it('ticks a step only when the account data says it is done', () => {
		expect(done(accountSteps(user, 0))).toEqual({
			'verify-email': false,
			'protect-account': false,
		});
		expect(done(accountSteps({ ...user, emailVerified: true }, 0))['verify-email']).toBe(true);
	});

	it('counts a passkey or two-factor authentication as a protected account', () => {
		expect(done(accountSteps(user, 1))['protect-account']).toBe(true);
		expect(done(accountSteps({ ...user, twoFactorEnabled: true }, 0))['protect-account']).toBe(
			true,
		);
		// The passkey count failed to load: two-factor authentication still decides.
		expect(done(accountSteps({ ...user, twoFactorEnabled: true }, null))['protect-account']).toBe(
			true,
		);
		expect(done(accountSteps({ ...user, twoFactorEnabled: null }, null))['protect-account']).toBe(
			false,
		);
	});

	it('resends the verification from the list and links the other steps to where they are done', () => {
		const [verify, protect] = accountSteps(user, 0);
		expect(verify?.description).toContain('ada@example.com');
		// Settings cannot send the email again, so the step does it itself, to the account's address.
		expect(verify?.action).toEqual({
			label: 'Resend the link',
			resendVerificationTo: 'ada@example.com',
		});
		expect(protect?.action).toEqual({
			label: 'Open security settings',
			href: '/app/settings/security',
		});
	});

	it('reports progress and completion', () => {
		expect(stepProgress(accountSteps(user, 0))).toEqual({ done: 0, total: 2, complete: false });
		expect(stepProgress(accountSteps({ ...user, emailVerified: true }, 2))).toEqual({
			done: 2,
			total: 2,
			complete: true,
		});
	});
});

describe('greetingName', () => {
	it('greets by the first word of the name, and by nothing without one', () => {
		expect(greetingName('Ada Lovelace')).toBe('Ada');
		expect(greetingName('  Grace  ')).toBe('Grace');
		expect(greetingName('')).toBe('');
		expect(greetingName(null)).toBe('');
	});
});
