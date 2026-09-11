<script lang="ts">
	import { Alert, Button, FormField, Input } from '@repo/ui';
	import { onMount } from 'svelte';
	import { defaults, setError, superForm } from 'sveltekit-superforms';
	import { browser } from '$app/environment';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { returnUrl } from '$lib/api';
	import { authClient } from '$lib/auth';
	import { spaForm, zodForm } from '$lib/forms';
	import { m } from '$lib/paraglide/messages';
	import { ForgotPasswordSchema } from '$lib/schemas';
	import { withoutSensitiveParams } from '$lib/utils/redirect';

	let sent = $state(false);

	// The address arrives in the URL from the sign-in page; the form has it now, so it leaves the
	// address bar (analytics, error reports and access logs all see the URL).
	onMount(() => {
		const stripped = withoutSensitiveParams(page.url);
		if (stripped) replaceState(stripped, page.state);
	});

	const sf = superForm(
		// The sign-in page links here with the address the user already typed.
		defaults({ email: page.url.searchParams.get('email') ?? '' }, zodForm(ForgotPasswordSchema)),
		{
			...spaForm,
			validators: zodForm(ForgotPasswordSchema),
			async onUpdate({ form }) {
				if (!form.valid) return;
				// The API answers the same way whether or not the address exists, so neither do we.
				const result = await authClient.requestPasswordReset({
					email: form.data.email,
					redirectTo: returnUrl('/reset-password'),
				});
				if (result.error) {
					setError(form, result.error.message ?? m.auth_forgot_error_failed());
					return;
				}
				sent = true;
			},
		},
	);
	const { form, errors, enhance, submitting } = sf;
</script>

<svelte:head><title>{m.auth_forgot_title()} · {m.common_app_name()}</title></svelte:head>

<h1 class="text-2xl font-semibold">{m.auth_forgot_heading()}</h1>

{#if sent}
	<Alert variant="success">{m.auth_forgot_sent({ email: $form.email })}</Alert>
{:else}
	<p class="text-muted-foreground text-sm">{m.auth_forgot_description()}</p>

	<form class="flex flex-col gap-4" method="POST" novalidate use:enhance>
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

		{#if $errors._errors?.length}
			<Alert variant="error">{$errors._errors[0]}</Alert>
		{/if}

		<!-- Off until hydration: before `use:enhance` attaches, a click would POST natively (405). -->
		<Button type="submit" disabled={!browser || $submitting}>
			{$submitting ? m.common_sending() : m.auth_forgot_submit()}
		</Button>
	</form>
{/if}

<p class="text-muted-foreground text-sm">
	<a class="underline" href="/login">{m.auth_back_to_sign_in()}</a>
</p>
