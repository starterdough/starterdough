import { ORPCError } from '@repo/api-client';
import { type SuperValidated, setError } from 'sveltekit-superforms';
import { type ZodValidationSchema, zod4 } from 'sveltekit-superforms/adapters';
import type * as z from 'zod';
import { safeParseAsync } from 'zod/v4/core';
import { m } from '$lib/paraglide/messages';

/**
 * Options every form shares. Forms run `sveltekit-superforms` in SPA mode: the schema (shared with
 * the contract where one exists) validates on the client and `onUpdate` calls the API — there are
 * no form actions, the API is the backend on every target (SSR, static SPA, Tauri).
 *
 *   superForm(defaults(zodForm(Schema)), { ...spaForm, validators: zodForm(Schema), async onUpdate({ form }) {…} })
 *
 * - `dataType: 'json'` — typed data, no FormData round trip.
 * - `resetForm: false` — keep the input on failure; handlers reset explicitly on success.
 * - `taintedMessage: null` — no "leave page?" prompt; set one per form where unsaved edits matter.
 * - `applyAction` / `invalidateAll: false` — no page-store round trip; handlers invalidate exactly
 *   what they changed (TanStack keys, `invalidate('app:…')`).
 */
export const spaForm = {
	SPA: true,
	dataType: 'json',
	resetForm: false,
	taintedMessage: null,
	applyAction: false,
	invalidateAll: false,
} as const;

/**
 * The Zod adapter, with validation copy in the user's language.
 *
 * Contract schemas (`WorkspaceCreateInputSchema`, `SlugSchema`, …) carry the rules and English
 * messages meant for API consumers; a schema-level message always wins over Zod error maps, so
 * the UI phrases each issue itself from its `code`/`format`/`params` after validating. Anything
 * this map does not know keeps Zod's own text, which `applyZodLocale` ($lib/i18n) localises.
 */
export function zodForm<T extends ZodValidationSchema>(schema: T) {
	const adapter = zod4(schema);
	return {
		...adapter,
		validate: async (data: unknown) => {
			const result = await safeParseAsync(schema, data);
			if (result.success) return { success: true as const, data: result.data };
			return {
				success: false as const,
				issues: result.error.issues.map((issue) => ({
					path: issue.path,
					message: issueMessage(issue) ?? issue.message,
				})),
			};
		},
	} as typeof adapter;
}

/** Localised text for the validation issues our schemas produce; `undefined` keeps Zod's message. */
export function issueMessage(issue: z.core.$ZodIssue): string | undefined {
	const field = String(issue.path.at(-1) ?? '');
	switch (issue.code) {
		case 'invalid_type':
			return issue.input === undefined || issue.input === '' ? m.validation_required() : undefined;
		case 'too_small':
			if (issue.origin !== 'string') return undefined;
			return Number(issue.minimum) <= 1
				? m.validation_required()
				: m.validation_too_small_string({ minimum: issue.minimum });
		case 'too_big':
			return issue.origin === 'string'
				? m.validation_too_big_string({ maximum: issue.maximum })
				: undefined;
		case 'invalid_format':
			if (issue.format === 'email') return m.validation_email();
			if (issue.format === 'url') return m.validation_url();
			if (issue.format === 'regex') {
				return field === 'key' ? m.validation_flag_key() : m.validation_slug();
			}
			return undefined;
		case 'custom':
			// The contract tags its own refusals so the UI can phrase them (`params.reason`).
			if (issue.params?.reason === 'reserved_slug') return m.validation_slug_reserved();
			if (issue.params?.reason === 'control_characters') return m.validation_control_characters();
			return undefined;
		default:
			return undefined;
	}
}

/** The message an API error carries, or the generic fallback. */
export function messageOf(error: { message?: string | undefined } | null | undefined) {
	return error?.message ?? m.common_error_generic();
}

/**
 * Maps an API failure back onto a form: oRPC input-validation issues land on their fields,
 * anything else becomes the form-level error (`$errors._errors`). Returns the message so callers
 * can also toast it.
 */
export function applyApiError(
	// biome-ignore lint/suspicious/noExplicitAny: works with any form shape
	form: SuperValidated<Record<string, any>>,
	error: unknown,
	messages: Partial<Record<string, string>> & { fallback?: string } = {},
): string {
	const issues =
		error instanceof ORPCError && error.code === 'BAD_REQUEST' ? issuesOf(error.data) : undefined;
	if (issues?.length) {
		for (const issue of issues) {
			const path = issue.path?.map(String).join('.');
			if (path) setError(form, path, issue.message);
			else setError(form, issue.message);
		}
		return m.common_error_check_fields();
	}

	const code = error instanceof ORPCError ? error.code : null;
	const message =
		(code && messages[code]) ||
		(error instanceof Error && error.message) ||
		messages.fallback ||
		m.common_error_generic();
	setError(form, message);
	return message;
}

type Issue = { message: string; path?: ReadonlyArray<string | number | symbol> };

/** oRPC reports schema failures as `{ issues: StandardSchemaV1.Issue[] }`. */
function issuesOf(data: unknown): Issue[] | undefined {
	if (!data || typeof data !== 'object' || !('issues' in data)) return undefined;
	const issues = (data as { issues: unknown }).issues;
	if (!Array.isArray(issues)) return undefined;
	return issues.filter(
		(issue): issue is Issue =>
			typeof issue === 'object' && issue !== null && typeof issue.message === 'string',
	);
}
