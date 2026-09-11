<script lang="ts">
	import { Alert, Button, FormField, Input } from '@repo/ui';
	import { defaults, setError, superForm } from 'sveltekit-superforms';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { returnUrl } from '$lib/api';
	import { authClient } from '$lib/auth';
	import { spaForm, zodForm } from '$lib/forms';
	import { m } from '$lib/paraglide/messages';
	import { SignUpSchema } from '$lib/schemas';
	import { afterSignUp, safeNext } from '$lib/utils/redirect';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Where to land after sign-up: a `next` the app vouches for, else the default. */
	const next = $derived(safeNext(page.url.searchParams.get('next')) ?? afterSignUp(page.url));
	/** The same destination after the emailed verification link signs the user in. */
	const verifyUrl = $derived(returnUrl(`/verify-email?next=${encodeURIComponent(next)}`));

	let exists = $state(false);
	let sent = $state(false);
	let resend = $state<'idle' | 'sending' | 'sent'>('idle');
	/** Errors of the "check your inbox" step, which has no form. */
	let resendError = $state<string | null>(null);

	const sf = superForm(defaults(zodForm(SignUpSchema)), {
		...spaForm,
		validators: zodForm(SignUpSchema),
		async onUpdate({ form }) {
			if (!form.valid) return;
			exists = false;
			const { name, email, password } = form.data;
			const result = await authClient.signUp.email({
				name,
				email,
				password,
				callbackURL: verifyUrl,
			});
			if (result.error) {
				// 1.7 reports USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL; older builds USER_ALREADY_EXISTS.
				if (result.error.code?.startsWith('USER_ALREADY_EXISTS')) exists = true;
				else setError(form, result.error.message ?? m.auth_signup_error_failed());
				return;
			}
			if (data.authConfig.requireEmailVerification) {
				sent = true;
				return;
			}
			await goto(next);
		},
	});
	const { form, errors, enhance, submitting } = sf;

	async function resendVerification() {
		resend = 'sending';
		resendError = null;
		const result = await authClient.sendVerificationEmail({
			email: $form.email,
			callbackURL: verifyUrl,
		});
		if (result.error) {
			resend = 'idle';
			resendError = result.error.message ?? m.auth_resend_error();
			return;
		}
		resend = 'sent';
	}
</script>

<svelte:head><title>{m.auth_signup_create_account()} · {m.common_app_name()}</title></svelte:head>

{#if sent}
	<h1 class="text-2xl font-semibold">{m.auth_check_inbox_title()}</h1>
	<Alert variant="success">{m.auth_signup_sent_text({ email: $form.email })}</Alert>
	{#if resendError}
		<Alert variant="error">{resendError}</Alert>
	{/if}
	<div class="flex items-center gap-3">
		{#if resend === 'sent'}
			<p class="text-muted-foreground text-sm">{m.auth_resend_sent()}</p>
		{:else}
			<Button variant="secondary" disabled={resend === 'sending'} onclick={resendVerification}>
				{resend === 'sending' ? m.common_sending() : m.auth_resend_button()}
			</Button>
		{/if}
		<a class="text-muted-foreground text-sm underline" href="/login">{m.auth_back_to_sign_in()}</a>
	</div>
{:else}
	<h1 class="text-2xl font-semibold">{m.auth_signup_heading()}</h1>

	<form class="flex flex-col gap-4" method="POST" novalidate use:enhance>
		<FormField label={m.common_name()} name="name" errors={$errors.name}>
			{#snippet children({ id, describedBy, invalid })}
				<Input
					{id}
					type="text"
					name="name"
					autocomplete="name"
					bind:value={$form.name}
					{invalid}
					aria-describedby={describedBy}
				/>
			{/snippet}
		</FormField>
		<FormField label={m.common_email()} name="email" errors={$errors.email}>
			{#snippet children({ id, describedBy, invalid })}
				<Input
					{id}
					type="email"
					name="email"
					autocomplete="email"
					bind:value={$form.email}
					{invalid}
					aria-describedby={describedBy}
				/>
			{/snippet}
		</FormField>
		<FormField
			label={m.common_password()}
			name="password"
			errors={$errors.password}
			hint={m.auth_password_hint()}
		>
			{#snippet children({ id, describedBy, invalid })}
				<Input
					{id}
					type="password"
					name="password"
					autocomplete="new-password"
					bind:value={$form.password}
					{invalid}
					aria-describedby={describedBy}
				/>
			{/snippet}
		</FormField>
		<FormField label={m.auth_signup_confirm_password()} name="confirm" errors={$errors.confirm}>
			{#snippet children({ id, describedBy, invalid })}
				<Input
					{id}
					type="password"
					name="confirm"
					autocomplete="new-password"
					bind:value={$form.confirm}
					{invalid}
					aria-describedby={describedBy}
				/>
			{/snippet}
		</FormField>

		{#if exists}
			<Alert variant="error">
				{m.auth_signup_error_exists()}
				<a class="underline" href="/login">{m.auth_signup_sign_in_instead()}</a>
			</Alert>
		{:else if $errors._errors?.length}
			<Alert variant="error">{$errors._errors[0]}</Alert>
		{/if}

		<!-- Off until hydration: before `use:enhance` attaches, a click would POST natively (405). -->
		<Button type="submit" disabled={!browser || $submitting}>
			{$submitting ? m.auth_signup_submitting() : m.auth_signup_create_account()}
		</Button>
	</form>

	<p class="text-muted-foreground text-sm">
		{m.auth_signup_have_account()}
		<a class="underline" href="/login">{m.common_sign_in()}</a>
	</p>
{/if}
