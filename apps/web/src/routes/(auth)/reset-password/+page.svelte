<script lang="ts">
	import { Alert, Button, FormField, Input } from '@repo/ui';
	import { onMount } from 'svelte';
	import { defaults, setError, superForm } from 'sveltekit-superforms';
	import { browser } from '$app/environment';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { authClient } from '$lib/auth';
	import { spaForm, zodForm } from '$lib/forms';
	import { m } from '$lib/paraglide/messages';
	import { ResetPasswordSchema } from '$lib/schemas';
	import { withoutSensitiveParams } from '$lib/utils/redirect';

	// Better Auth lands here with `?token=` from a valid emailed link, `?error=INVALID_TOKEN`
	// otherwise. Read once, not derived: the token is a single-use credential and the address bar
	// reaches the history, the referrer, analytics and error reports, so it leaves the URL on mount.
	const token = page.url.searchParams.get('token');
	const linkError = page.url.searchParams.get('error');

	onMount(() => {
		const stripped = withoutSensitiveParams(page.url);
		if (stripped) replaceState(stripped, page.state);
	});

	let done = $state(false);

	const sf = superForm(defaults(zodForm(ResetPasswordSchema)), {
		...spaForm,
		validators: zodForm(ResetPasswordSchema),
		async onUpdate({ form }) {
			if (!form.valid || !token) return;
			const result = await authClient.resetPassword({ newPassword: form.data.password, token });
			if (result.error) {
				setError(form, result.error.message ?? m.auth_reset_error_failed());
				return;
			}
			done = true;
		},
	});
	const { form, errors, enhance, submitting } = sf;
</script>

<svelte:head><title>{m.auth_reset_title()} · {m.common_app_name()}</title></svelte:head>

<h1 class="text-2xl font-semibold">{m.auth_reset_title()}</h1>

{#if linkError}
	<Alert variant="error">{m.auth_reset_link_invalid()}</Alert>
	<p class="text-muted-foreground text-sm">
		<a class="underline" href="/forgot-password">{m.auth_reset_request_new_link()}</a>
	</p>
{:else if !token}
	<Alert>{m.auth_reset_open_link()}</Alert>
	<p class="text-muted-foreground text-sm">
		{m.auth_reset_no_email()}
		<a class="underline" href="/forgot-password">{m.auth_reset_request_new_link()}</a>
	</p>
{:else if done}
	<Alert variant="success">{m.auth_reset_done()}</Alert>
	<Button class="w-fit" href="/login">{m.common_sign_in()}</Button>
{:else}
	<form class="flex flex-col gap-4" method="POST" novalidate use:enhance>
		<FormField
			label={m.auth_reset_new_password()}
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
		<FormField label={m.auth_reset_confirm_password()} name="confirm" errors={$errors.confirm}>
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

		{#if $errors._errors?.length}
			<Alert variant="error">{$errors._errors[0]}</Alert>
		{/if}

		<!-- Off until hydration: before `use:enhance` attaches, a click would POST natively (405). -->
		<Button type="submit" disabled={!browser || $submitting}>
			{$submitting ? m.auth_reset_submitting() : m.auth_reset_submit()}
		</Button>
	</form>
{/if}
