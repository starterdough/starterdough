<script lang="ts">
	import { Alert, Button, Input, Label } from '@repo/ui';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { authClient } from '$lib/auth';
	import { m } from '$lib/paraglide/messages';
	import { safeNext } from '$lib/utils/redirect';

	const next = $derived(safeNext(page.url.searchParams.get('next')) ?? '/app');

	let code = $state('');
	let trustDevice = $state(false);
	let useBackup = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		const result = useBackup
			? await authClient.twoFactor.verifyBackupCode({ code, trustDevice })
			: await authClient.twoFactor.verifyTotp({ code, trustDevice });
		busy = false;
		if (result.error) {
			error = result.error.message ?? m.auth_two_factor_error_invalid();
			return;
		}
		await goto(next);
	}

	function toggleMethod() {
		useBackup = !useBackup;
		code = '';
		error = null;
	}
</script>

<svelte:head><title>{m.auth_two_factor_title()} · {m.common_app_name()}</title></svelte:head>

<h1 class="text-2xl font-semibold">{m.auth_two_factor_title()}</h1>
<p class="text-muted-foreground text-sm">
	{useBackup ? m.auth_two_factor_backup_description() : m.auth_two_factor_totp_description()}
</p>

<form class="flex flex-col gap-4" onsubmit={submit}>
	{#if useBackup}
		<Label>
			{m.auth_two_factor_backup_code()}
			<Input
				type="text"
				name="code"
				autocomplete="off"
				autocapitalize="off"
				spellcheck={false}
				bind:value={code}
				required
			/>
		</Label>
	{:else}
		<Label>
			{m.auth_two_factor_code()}
			<Input
				type="text"
				name="code"
				inputmode="numeric"
				autocomplete="one-time-code"
				pattern="[0-9]*"
				minlength={6}
				maxlength={6}
				class="tracking-widest"
				bind:value={code}
				required
			/>
		</Label>
	{/if}

	<label class="flex items-center gap-2 text-sm">
		<input class="border-border rounded" type="checkbox" bind:checked={trustDevice}>
		{m.auth_two_factor_trust_device()}
	</label>

	{#if error}
		<Alert variant="error">{error}</Alert>
	{/if}

	<Button type="submit" disabled={busy}>
		{busy ? m.auth_two_factor_submitting() : m.auth_two_factor_submit()}
	</Button>
</form>

<p class="text-muted-foreground text-sm">
	<button class="underline" type="button" onclick={toggleMethod}>
		{useBackup ? m.auth_two_factor_use_app() : m.auth_two_factor_use_backup()}
	</button>
	· <a class="underline" href="/login">{m.auth_back_to_sign_in()}</a>
</p>
