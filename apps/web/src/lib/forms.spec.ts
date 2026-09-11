import { ORPCError } from '@repo/api-client';
import { defaults } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { describe, expect, it } from 'vitest';
import { applyApiError } from './forms';
import { SignInSchema } from './schemas';

/** A fresh, valid `SuperValidated` — what `onUpdate` hands to the page. */
function form() {
	return defaults(zod4(SignInSchema));
}

describe('applyApiError', () => {
	it('puts oRPC input-validation issues on their fields', () => {
		const target = form();
		const error = new ORPCError('BAD_REQUEST', {
			data: { issues: [{ message: 'Not an address', path: ['email'] }] },
		});

		const message = applyApiError(target, error);

		expect(target.errors.email).toEqual(['Not an address']);
		expect(target.errors._errors).toBeUndefined();
		expect(target.valid).toBe(false);
		expect(message).toBe('Please check the highlighted fields.');
	});

	it('turns an issue without a path into a form-level error', () => {
		const target = form();
		const error = new ORPCError('BAD_REQUEST', { data: { issues: [{ message: 'Nope' }] } });

		applyApiError(target, error);

		expect(target.errors._errors).toEqual(['Nope']);
	});

	it('uses the mapped message for a known code', () => {
		const target = form();

		const message = applyApiError(target, new ORPCError('CONFLICT'), {
			CONFLICT: 'That address is taken.',
		});

		expect(target.errors._errors).toEqual(['That address is taken.']);
		expect(target.errors.email).toBeUndefined();
		expect(message).toBe('That address is taken.');
	});

	it("keeps the API's own message for an unmapped code", () => {
		const target = form();

		const message = applyApiError(target, new ORPCError('FORBIDDEN', { message: 'No access' }), {
			CONFLICT: 'That address is taken.',
		});

		expect(target.errors._errors).toEqual(['No access']);
		expect(message).toBe('No access');
	});

	it('uses the message of a plain Error', () => {
		const target = form();

		const message = applyApiError(target, new Error('x'));

		expect(target.errors._errors).toEqual(['x']);
		expect(message).toBe('x');
	});

	it('falls back for anything else', () => {
		const target = form();

		const message = applyApiError(target, 'not an error', { fallback: 'Could not save' });

		expect(target.errors._errors).toEqual(['Could not save']);
		expect(message).toBe('Could not save');
	});

	it('has a last-resort message without a fallback', () => {
		const target = form();

		expect(applyApiError(target, undefined)).toBe('Something went wrong');
		expect(target.errors._errors).toEqual(['Something went wrong']);
	});
});
