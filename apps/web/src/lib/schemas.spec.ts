import { describe, expect, it } from 'vitest';
import { ForgotPasswordSchema, ResetPasswordSchema, SignInSchema, SignUpSchema } from './schemas';

/** First message reported for `path`, or `undefined` when the field is fine. */
function issueAt(result: { success: boolean; error?: { issues: unknown[] } }, path: string) {
	if (result.success || !result.error) return undefined;
	const issues = result.error.issues as { path: PropertyKey[]; message: string }[];
	return issues.find((issue) => issue.path.join('.') === path)?.message;
}

describe('SignInSchema', () => {
	it('accepts an email and any non-empty password', () => {
		const result = SignInSchema.safeParse({ email: 'a@b.co', password: 'x' });
		expect(result.success).toBe(true);
	});

	it('rejects a malformed email', () => {
		const result = SignInSchema.safeParse({ email: 'nope', password: 'x' });
		expect(issueAt(result, 'email')).toBe('Enter a valid email address');
	});

	it('rejects an empty password', () => {
		const result = SignInSchema.safeParse({ email: 'a@b.co', password: '' });
		expect(issueAt(result, 'password')).toBe('Enter your password');
	});
});

describe('SignUpSchema', () => {
	const valid = {
		name: ' Ada ',
		email: 'ada@example.com',
		password: 'longenough',
		confirm: 'longenough',
	};

	it('accepts matching passwords and trims the name', () => {
		const result = SignUpSchema.safeParse(valid);
		expect(result.success).toBe(true);
		expect(result.data?.name).toBe('Ada');
	});

	it('requires a name', () => {
		expect(issueAt(SignUpSchema.safeParse({ ...valid, name: '   ' }), 'name')).toBe(
			'Enter your name',
		);
	});

	it('caps the name at 80 characters', () => {
		expect(issueAt(SignUpSchema.safeParse({ ...valid, name: 'x'.repeat(81) }), 'name')).toBe(
			'Use at most 80 characters',
		);
	});

	it('rejects a malformed email', () => {
		expect(issueAt(SignUpSchema.safeParse({ ...valid, email: 'ada@' }), 'email')).toBe(
			'Enter a valid email address',
		);
	});

	it('requires at least 8 characters', () => {
		const result = SignUpSchema.safeParse({ ...valid, password: 'short', confirm: 'short' });
		expect(issueAt(result, 'password')).toBe('Use at least 8 characters');
	});

	it('reports a mismatch on the confirm field', () => {
		const result = SignUpSchema.safeParse({ ...valid, confirm: 'different' });
		expect(issueAt(result, 'confirm')).toBe('Passwords do not match');
		expect(issueAt(result, 'password')).toBeUndefined();
	});
});

describe('ForgotPasswordSchema', () => {
	it('accepts an email', () => {
		expect(ForgotPasswordSchema.safeParse({ email: 'a@b.co' }).success).toBe(true);
	});

	it('rejects a malformed email', () => {
		expect(issueAt(ForgotPasswordSchema.safeParse({ email: '' }), 'email')).toBe(
			'Enter a valid email address',
		);
	});
});

describe('ResetPasswordSchema', () => {
	it('accepts matching passwords', () => {
		const result = ResetPasswordSchema.safeParse({ password: 'longenough', confirm: 'longenough' });
		expect(result.success).toBe(true);
	});

	it('requires at least 8 characters', () => {
		const result = ResetPasswordSchema.safeParse({ password: 'short', confirm: 'short' });
		expect(issueAt(result, 'password')).toBe('Use at least 8 characters');
	});

	it('reports a mismatch on the confirm field', () => {
		const result = ResetPasswordSchema.safeParse({ password: 'longenough', confirm: 'longenougH' });
		expect(issueAt(result, 'confirm')).toBe('Passwords do not match');
	});
});
