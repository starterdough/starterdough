import { z } from 'zod';
import { m } from '$lib/paraglide/messages';

/**
 * Client-side form schemas for the flows Better Auth owns (no contract entry to share).
 *
 * Messages are lazy (`error: () => m.…()`) so they are phrased in the locale current at validation
 * time, not the one seen when this module was first evaluated.
 */

const Email = z.email({ error: () => m.validation_email() });
const NewPassword = z
	.string()
	.min(8, { error: () => m.validation_too_small_string({ minimum: 8 }) });
const Name = z
	.string()
	.trim()
	.min(1, { error: () => m.auth_validation_name_required() })
	.max(80, { error: () => m.validation_too_big_string({ maximum: 80 }) });

export const SignInSchema = z.object({
	email: Email,
	password: z.string().min(1, { error: () => m.auth_validation_password_required() }),
});
export type SignInInput = z.infer<typeof SignInSchema>;

export const SignUpSchema = z
	.object({
		name: Name,
		email: Email,
		password: NewPassword,
		confirm: z.string(),
	})
	.refine((value) => value.password === value.confirm, {
		error: () => m.auth_validation_passwords_mismatch(),
		path: ['confirm'],
	});
export type SignUpInput = z.infer<typeof SignUpSchema>;

export const ForgotPasswordSchema = z.object({ email: Email });
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z
	.object({
		password: NewPassword,
		confirm: z.string(),
	})
	.refine((value) => value.password === value.confirm, {
		error: () => m.auth_validation_passwords_mismatch(),
		path: ['confirm'],
	});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
