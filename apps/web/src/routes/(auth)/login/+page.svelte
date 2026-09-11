<script lang="ts">
	import { Alert, Button, FormField, Input } from '@repo/ui';
	import { defaults, setError, superForm } from 'sveltekit-superforms';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { RETURN_URLS_AVAILABLE, returnUrl } from '$lib/api';
	import { authClient } from '$lib/auth';
	import { spaForm, zodForm } from '$lib/forms';
	import { m } from '$lib/paraglide/messages';
	import { SignInSchema } from '$lib/schemas';
	import { safeNext } from '$lib/utils/redirect';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const next = $derived(safeNext(page.url.searchParams.get('next')) ?? '/app');

	let unverified = $state(false);
	let resend = $state<'idle' | 'sending' | 'sent'>('idle');
	let passkeys = $state(false);
	/** Sign-in attempts outside the form (social, passkey) report here. */
	let authError = $state<string | null>(null);
	let passkeyBusy = $state(false);

	// WebAuthn is browser-only: decide after mount so the server-rendered markup is stable.
	$effect(() => {
		passkeys = 'PublicKeyCredential' in window;
	});

	const sf = superForm(defaults(zodForm(SignInSchema)), {
		...spaForm,
		validators: zodForm(SignInSchema),
		async onUpdate({ form }) {
			if (!form.valid) return;
			unverified = false;
			authError = null;
			const result = await authClient.signIn.email(form.data);
			if (result.error) {
				if (result.error.code === 'EMAIL_NOT_VERIFIED') unverified = true;
				else setError(form, result.error.message ?? m.auth_login_error_failed());
				return;
			}
			// Password accepted but the account has 2FA: the client plugin already sent us to /two-factor.
			if (result.data && 'twoFactorRedirect' in result.data && result.data.twoFactorRedirect)
				return;
			await goto(next);
		},
	});
	const { form, errors, enhance, submitting } = sf;

	const busy = $derived($submitting || passkeyBusy);
	const error = $derived($errors._errors?.[0] ?? authError);

	async function resendVerification() {
		resend = 'sending';
		const result = await authClient.sendVerificationEmail({
			email: $form.email,
			callbackURL: returnUrl('/verify-email'),
		});
		if (result.error) {
			resend = 'idle';
			authError = result.error.message ?? m.auth_resend_error();
			return;
		}
		resend = 'sent';
	}

	// The provider redirects the *system* browser back to `callbackURL`, so it must be an address
	// that browser can reach: `RETURN_URLS_AVAILABLE` is false in a shell build without
	// `PUBLIC_WEB_URL`, and the buttons are not rendered at all rather than dead-ending the user.
	const social = $derived(RETURN_URLS_AVAILABLE ? data.authConfig.socialProviders : []);

	async function signInWithSocial(provider: 'github' | 'google') {
		authError = null;
		const result = await authClient.signIn.social({
			provider,
			callbackURL: returnUrl(next),
		});
		if (result.error) authError = result.error.message ?? m.auth_login_error_failed();
	}

	async function signInWithPasskey() {
		authError = null;
		passkeyBusy = true;
		const result = await authClient.signIn.passkey();
		passkeyBusy = false;
		if (result.error) {
			authError = result.error.message ?? m.auth_login_error_passkey();
			return;
		}
		await goto(next);
	}
</script>

<svelte:head><title>{m.common_sign_in()} · {m.common_app_name()}</title></svelte:head>

<h1 class="text-2xl font-semibold">{m.common_sign_in()}</h1>

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
	<FormField label={m.common_password()} name="password" errors={$errors.password}>
		{#snippet aside()}
			<a
				class="text-muted-foreground text-sm underline"
				href="/forgot-password?email={encodeURIComponent($form.email)}"
			>
				{m.auth_login_forgot_password()}
			</a>
		{/snippet}
		{#snippet children({ id, describedBy, invalid })}
			<Input
				{id}
				type="password"
				name="password"
				autocomplete="current-password"
				bind:value={$form.password}
				{invalid}
				aria-describedby={describedBy}
			/>
		{/snippet}
	</FormField>

	{#if error}
		<Alert variant="error">{error}</Alert>
	{/if}

	{#if unverified}
		<Alert class="flex flex-col gap-2">
			<p>{m.auth_login_unverified()}</p>
			{#if resend === 'sent'}
				<p class="text-muted-foreground">{m.auth_resend_sent()}</p>
			{:else}
				<Button
					variant="secondary"
					size="sm"
					class="w-fit"
					disabled={resend === 'sending'}
					onclick={resendVerification}
				>
					{resend === 'sending' ? m.common_sending() : m.auth_login_resend_verification()}
				</Button>
			{/if}
		</Alert>
	{/if}

	<!-- Off until hydration: before `use:enhance` attaches, a click would POST natively (405). -->
	<Button type="submit" disabled={!browser || busy}>
		{$submitting ? m.auth_login_submitting() : m.common_sign_in()}
	</Button>
</form>

{#if social.length > 0 || passkeys}
	<div class="flex flex-col gap-2">
		{#if social.includes('github')}
			<Button variant="secondary" onclick={() => signInWithSocial('github')}>
				{m.auth_login_continue_github()}
			</Button>
		{/if}
		{#if social.includes('google')}
			<Button variant="secondary" onclick={() => signInWithSocial('google')}>
				{m.auth_login_continue_google()}
			</Button>
		{/if}
		{#if passkeys}
			<Button variant="secondary" disabled={busy} onclick={signInWithPasskey}>
				{m.auth_login_passkey()}
			</Button>
		{/if}
	</div>
{/if}

<p class="text-muted-foreground text-sm">
	{m.auth_login_no_account()}
	<a class="underline" href="/signup">{m.auth_login_create_account()}</a>
</p>
