import { m } from '#lib/paraglide/messages.js';
import type { PageSession } from '#lib/utils/session.js';

/**
 * The getting-started checklist on `/app`. Every step is read from data the page already has, so
 * a step is ticked because it is true, not because someone clicked it away: verify the address
 * and the account is verified; add a passkey and it is protected.
 */
export interface GettingStartedStep {
	id: string;
	done: boolean;
	title: string;
	description: string;
	action: StepAction;
}

/**
 * The step's control: a link to the page where the user does it, or a button that does it from the
 * list when no page would help.
 */
export type StepAction =
	| { label: string; href: string }
	/**
	 * Send the verification email again. The step waits only on the link in that email, and the
	 * settings page has no way to send it; a link there would lead nowhere.
	 */
	| { label: string; resendVerificationTo: string };

/**
 * The account half, the same in every edition. `passkeys` is how many the account has, or `null`
 * when the count could not be loaded; two-factor authentication alone still ticks the step then.
 */
export function accountSteps(
	user: Pick<PageSession['user'], 'email' | 'emailVerified'> & {
		// Better Auth's live session types the plugin field as optional.
		twoFactorEnabled?: boolean | null;
	},
	passkeys: number | null,
): GettingStartedStep[] {
	return [
		{
			id: 'verify-email',
			done: user.emailVerified,
			title: m.app_home_step_verify_title(),
			description: m.app_home_step_verify_description({ email: user.email }),
			action: { label: m.app_home_step_verify_action(), resendVerificationTo: user.email },
		},
		{
			id: 'protect-account',
			done: user.twoFactorEnabled === true || (passkeys ?? 0) > 0,
			title: m.app_home_step_protect_title(),
			description: m.app_home_step_protect_description(),
			action: { label: m.app_home_step_protect_action(), href: '/app/settings/security' },
		},
	];
}

/** How far along the list is, for the progress line and for hiding a finished list. */
export function stepProgress(steps: readonly GettingStartedStep[]): {
	done: number;
	total: number;
	complete: boolean;
} {
	const done = steps.filter((step) => step.done).length;
	return { done, total: steps.length, complete: done === steps.length };
}

/** The first word of the name, for a greeting; empty when there is no name to use. */
export function greetingName(name: string | null | undefined): string {
	return name?.trim().split(/\s+/)[0] ?? '';
}
