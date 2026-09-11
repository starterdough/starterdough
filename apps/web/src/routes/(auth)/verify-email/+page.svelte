<script lang="ts">
	import { Alert, Button, Input, Label } from '@repo/ui';
	import { onMount } from 'svelte';
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { returnUrl } from '$lib/api';
	import { authClient } from '$lib/auth';
	import { m } from '$lib/paraglide/messages';
	import { safeNext, withoutSensitiveParams } from '$lib/utils/redirect';

	// The emailed link redirects here: with a fresh session on success, `?error=<CODE>` otherwise.
	// Read once, not derived: the address is taken out of the URL on mount so it does not reach
	// analytics, error reports or an access log.
	const linkError = page.url.searchParams.get('error');
	const emailParam = page.url.searchParams.get('email');
	// Sign-up put its destination here so a plan picked on the pricing page survives verification.
	const next = safeNext(page.url.searchParams.get('next')) ?? '/app';

	onMount(() => {
		const stripped = withoutSensitiveParams(page.url);
		if (stripped) replaceState(stripped, page.state);
	});

	const messages: Record<string, string> = {
		INVALID_TOKEN: m.auth_verify_error_invalid_token(),
		TOKEN_EXPIRED: m.auth_verify_error_token_expired(),
		USER_NOT_FOUND: m.auth_verify_error_user_not_found(),
	};
	const linkMessage = $derived(
		(linkError && messages[linkError.toUpperCase()]) || m.auth_verify_error_generic(),
	);

	let email = $state(emailParam ?? '');
	let checking = $state(true);
	let resend = $state<'idle' | 'sending' | 'sent'>('idle');
	let error = $state<string | null>(null);

	// Better Auth signs the user in when the link is valid: if a session exists, carry on.
	$effect(() => {
		if (linkError) {
			checking = false;
			return;
		}
		let cancelled = false;
		authClient
			.getSession()
			.then(({ data }) => {
				if (cancelled) return;
				if (data) void goto(next);
				else checking = false;
			})
			.catch(() => {
				if (!cancelled) checking = false;
			});
		return () => {
			cancelled = true;
		};
	});

	async function resendVerification(event?: SubmitEvent) {
		event?.preventDefault();
		resend = 'sending';
		error = null;
		const result = await authClient.sendVerificationEmail({
			email,
			callbackURL: returnUrl('/verify-email'),
		});
		if (result.error) {
			resend = 'idle';
			error = result.error.message ?? m.auth_resend_error();
			return;
		}
		resend = 'sent';
	}
</script>

<svelte:head><title>{m.auth_verify_title()} · {m.common_app_name()}</title></svelte:head>

{#if linkError}
	<h1 class="text-2xl font-semibold">{m.auth_verify_failed_title()}</h1>
	<Alert variant="error">{linkMessage}</Alert>

	{#if resend === 'sent'}
		<Alert variant="success">{m.auth_verify_resent()}</Alert>
	{:else}
		<form class="flex flex-col gap-4" onsubmit={resendVerification}>
			<Label>
				{m.common_email()}
				<Input type="email" name="email" autocomplete="email" bind:value={email} required />
			</Label>
			{#if error}
				<Alert variant="error">{error}</Alert>
			{/if}
			<Button type="submit" disabled={resend === 'sending'}>
				{resend === 'sending' ? m.common_sending() : m.auth_verify_send_new_link()}
			</Button>
		</form>
	{/if}
{:else if checking}
	<h1 class="text-2xl font-semibold">{m.auth_verify_checking_title()}</h1>
	<p class="text-muted-foreground text-sm">{m.auth_verify_checking_description()}</p>
{:else if emailParam}
	<h1 class="text-2xl font-semibold">{m.auth_check_inbox_title()}</h1>
	<Alert>{m.auth_verify_sent_text({ email: emailParam })}</Alert>
	{#if error}
		<Alert variant="error">{error}</Alert>
	{/if}
	<div class="flex items-center gap-3">
		{#if resend === 'sent'}
			<p class="text-muted-foreground text-sm">{m.auth_resend_sent()}</p>
		{:else}
			<Button
				variant="secondary"
				disabled={resend === 'sending'}
				onclick={() => resendVerification()}
			>
				{resend === 'sending' ? m.common_sending() : m.auth_resend_button()}
			</Button>
		{/if}
		<a class="text-muted-foreground text-sm underline" href="/login">{m.common_sign_in()}</a>
	</div>
{:else}
	<h1 class="text-2xl font-semibold">{m.auth_verify_done_title()}</h1>
	<Alert variant="success">{m.auth_verify_done_text()}</Alert>
	<Button class="w-fit" href="/login">{m.common_sign_in()}</Button>
{/if}
