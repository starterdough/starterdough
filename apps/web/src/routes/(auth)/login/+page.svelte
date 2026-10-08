<script lang="ts">
	import { Alert, Button, FormField, Input } from '@repo/ui';
	import { defaults, setError, superForm } from 'sveltekit-superforms';
	import { PASSKEYS_AVAILABLE, returnUrl, SOCIAL_SIGN_IN_AVAILABLE } from '#lib/api.js';
	import { authClient } from '#lib/auth.js';
	import { spaForm, zodForm } from '#lib/forms.js';
	import { formatList } from '#lib/i18n.js';
	import { m } from '#lib/paraglide/messages.js';
	import { SignInSchema } from '#lib/schemas.js';
	import { routable, safeNext } from '#lib/utils/redirect.js';
	import { browser } from '$app/env';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const next = $derived(safeNext(page.url.searchParams.get('next')) ?? '/app');

	let unverified = $state(false);
	let resend = $state<'idle' | 'sending' | 'sent'>('idle');
	let passkeys = $state(false);
	/** Sign-in attempts outside the form (social, passkey) report here. */
	let authError = $state<string | null>(null);
	let passkeyBusy = $state(false);

	// WebAuthn is browser-only: decide after mount so the server-rendered markup is stable. Never
	// inside a shell, whose origin cannot use a passkey made for the web app (`PASSKEYS_AVAILABLE`).
	$effect(() => {
		passkeys = PASSKEYS_AVAILABLE && 'PublicKeyCredential' in window;
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
			await goto(await routable(next));
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

	// A provider round trip signs in the browser that made it, never a shell, so the shells offer
	// email and password only (`SOCIAL_SIGN_IN_AVAILABLE`) rather than buttons that cannot finish.
	const social = $derived(SOCIAL_SIGN_IN_AVAILABLE ? data.authConfig.socialProviders : []);

	// Someone who signed up with one of those providers has no password to type here. Resetting it
	// gives them one (Better Auth adds the password to the account), so the shell says so rather
	// than leave them at a form they cannot use.
	const providerNames = { github: 'GitHub', google: 'Google' } as const;
	const hiddenProviders = $derived(
		SOCIAL_SIGN_IN_AVAILABLE
			? []
			: data.authConfig.socialProviders.map((provider) => providerNames[provider]),
	);

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
		await goto(await routable(next));
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

{#if hiddenProviders.length > 0}
	<p class="text-muted-foreground text-sm">
		{m.auth_login_shell_no_password({
			providers: formatList(hiddenProviders, { type: 'disjunction' }),
		})}
	</p>
{/if}

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
