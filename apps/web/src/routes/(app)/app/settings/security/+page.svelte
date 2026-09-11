<script lang="ts">
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import { Alert, Button, Dialog, EmptyState, Input, Label, Skeleton } from '@repo/ui';
	import { toast } from 'svelte-sonner';
	import { renderSVG } from 'uqr';
	import { authClient } from '$lib/auth';
	import { messageOf } from '$lib/forms';
	import { formatDate } from '$lib/i18n';
	import { m } from '$lib/paraglide/messages';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const session = authClient.useSession();

	const placeholderRows = [0, 1, 2];

	// ---- Two-factor ----------------------------------------------------------
	// Live store first (it follows enable/disable without a reload), the /app layout load's snapshot
	// for the first render. The store is null during SSR, so this used to render the section as "off"
	// and then flip it to "on" after hydration — a wrong answer, which is worse than a skeleton.
	const twoFactorEnabled = $derived(
		$session.data
			? $session.data.user.twoFactorEnabled === true
			: data.session.user.twoFactorEnabled,
	);

	type PasswordPrompt = 'enable' | 'disable' | 'regenerate';
	const promptCopy: Record<PasswordPrompt, { text: string; action: string }> = {
		enable: {
			text: m.account_security_prompt_enable(),
			action: m.common_continue(),
		},
		disable: {
			text: m.account_security_prompt_disable(),
			action: m.account_security_2fa_disable(),
		},
		regenerate: {
			text: m.account_security_prompt_regenerate(),
			action: m.account_security_generate_codes(),
		},
	};

	let prompt = $state<PasswordPrompt | null>(null);
	let password = $state('');
	let twoFactorBusy = $state(false);
	let twoFactorError = $state<string | null>(null);

	type Setup = { totpURI: string; secret: string | null; backupCodes: string[] };
	let setup = $state<Setup | null>(null);
	let code = $state('');
	/** Freshly issued backup codes (after enabling or regenerating); shown until the page changes. */
	let backupCodes = $state<string[] | null>(null);
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	function openPrompt(kind: PasswordPrompt) {
		prompt = kind;
		password = '';
		twoFactorError = null;
	}

	function closePrompt() {
		prompt = null;
		password = '';
	}

	function secretFrom(totpURI: string) {
		try {
			return new URL(totpURI).searchParams.get('secret');
		} catch {
			return null;
		}
	}

	async function submitPassword(event: SubmitEvent) {
		event.preventDefault();
		if (!prompt) return;
		twoFactorBusy = true;
		twoFactorError = null;
		try {
			if (prompt === 'enable') await startEnable();
			else if (prompt === 'disable') await disable();
			else await regenerate();
		} finally {
			twoFactorBusy = false;
		}
	}

	async function startEnable() {
		const result = await authClient.twoFactor.enable({ password });
		if (result.error) {
			twoFactorError = messageOf(result.error);
			return;
		}
		// 1.7 also supports email/SMS OTP; we only offer authenticator apps (the default).
		if (result.data.method !== 'totp') {
			twoFactorError = m.account_security_unexpected_method();
			return;
		}
		setup = {
			totpURI: result.data.totpURI,
			secret: secretFrom(result.data.totpURI),
			backupCodes: result.data.backupCodes,
		};
		code = '';
		backupCodes = null;
		closePrompt();
	}

	function cancelSetup() {
		// Nothing is active until a code is verified, so abandoning setup is safe.
		setup = null;
		code = '';
	}

	async function verify(event: SubmitEvent) {
		event.preventDefault();
		if (!setup) return;
		twoFactorBusy = true;
		twoFactorError = null;
		const result = await authClient.twoFactor.verifyTotp({ code: code.trim() });
		twoFactorBusy = false;
		if (result.error) {
			twoFactorError = messageOf(result.error);
			return;
		}
		backupCodes = setup.backupCodes;
		setup = null;
		code = '';
		toast.success(m.account_security_2fa_on_toast());
	}

	async function disable() {
		const result = await authClient.twoFactor.disable({ password });
		if (result.error) {
			twoFactorError = messageOf(result.error);
			return;
		}
		closePrompt();
		backupCodes = null;
		toast.success(m.account_security_2fa_off_toast());
	}

	async function regenerate() {
		const result = await authClient.twoFactor.generateBackupCodes({ password });
		if (result.error) {
			twoFactorError = messageOf(result.error);
			return;
		}
		closePrompt();
		backupCodes = result.data.backupCodes;
		toast.success(m.account_security_codes_generated(), {
			description: m.account_security_codes_generated_description(),
		});
	}

	async function copyCodes(list: string[]) {
		try {
			await navigator.clipboard.writeText(list.join('\n'));
			copied = true;
			toast.success(m.account_security_codes_copied());
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => {
				copied = false;
			}, 2000);
		} catch {
			toast.error(m.account_security_copy_failed());
		}
	}

	// ---- Passkeys ------------------------------------------------------------
	// `ReturnType<>` on the generic client methods collapses to `any`; `$Infer` keeps the real shape.
	type Passkey = (typeof authClient.$Infer)['Passkey'];

	let passkeySupport = $state<boolean | null>(null);
	/** Read once, not derived: `loadPasskeys()` owns the list from the first refresh onwards. */
	// svelte-ignore state_referenced_locally -- initial value; `loadPasskeys()` keeps it live
	const seededPasskeys = data.passkeys;
	let passkeys = $state<Passkey[]>(seededPasskeys ?? []);
	// The load has the list on the first render; the skeleton rows are now only for a failed load.
	let passkeysLoading = $state(seededPasskeys === null);
	/** Separate from `passkeysLoading`: the effect must not re-fire when `loadPasskeys()` toggles it. */
	const needsPasskeyFetch = seededPasskeys === null;
	let passkeysError = $state<string | null>(null);
	let passkeyError = $state<string | null>(null);
	let addBusy = $state(false);
	let rowBusy = $state(false);
	let newPasskeyName = $state('');
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');
	/** Passkey awaiting confirmation in the remove dialog. */
	let removingPasskey = $state<Passkey | null>(null);

	/** Display name for a passkey; unnamed ones get a generic label. */
	function passkeyLabel(passkey: Passkey) {
		return passkey.name || m.account_security_passkey_unnamed();
	}

	$effect(() => {
		// WebAuthn availability can only be checked in the browser.
		passkeySupport = 'PublicKeyCredential' in window;
		if (needsPasskeyFetch) void loadPasskeys();
	});

	async function loadPasskeys() {
		passkeysLoading = true;
		passkeysError = null;
		const result = await authClient.passkey.listUserPasskeys();
		if (result.error) passkeysError = messageOf(result.error);
		else passkeys = result.data;
		passkeysLoading = false;
	}

	async function addPasskey(event: SubmitEvent) {
		event.preventDefault();
		const name = newPasskeyName.trim();
		addBusy = true;
		passkeyError = null;
		const result = await authClient.passkey.addPasskey(name ? { name } : undefined);
		addBusy = false;
		if (result.error) {
			passkeyError = messageOf(result.error);
			return;
		}
		newPasskeyName = '';
		toast.success(
			name ? m.account_security_passkey_added_named({ name }) : m.account_security_passkey_added(),
		);
		await loadPasskeys();
	}

	function startRename(passkey: Passkey) {
		renamingId = passkey.id;
		renameValue = passkey.name ?? '';
		passkeyError = null;
	}

	function cancelRename() {
		renamingId = null;
		renameValue = '';
	}

	async function saveRename(event: SubmitEvent) {
		event.preventDefault();
		const id = renamingId;
		const name = renameValue.trim();
		if (!id || !name) return;
		rowBusy = true;
		passkeyError = null;
		const result = await authClient.passkey.updatePasskey({ id, name });
		rowBusy = false;
		if (result.error) {
			passkeyError = messageOf(result.error);
			return;
		}
		cancelRename();
		toast.success(m.account_security_passkey_renamed({ name }));
		await loadPasskeys();
	}

	async function removePasskey() {
		const passkey = removingPasskey;
		if (!passkey) return;
		rowBusy = true;
		passkeyError = null;
		const result = await authClient.passkey.deletePasskey({ id: passkey.id });
		rowBusy = false;
		removingPasskey = null;
		if (result.error) {
			passkeyError = messageOf(result.error);
			return;
		}
		toast.success(
			passkey.name
				? m.account_security_passkey_removed_named({ name: passkey.name })
				: m.account_security_passkey_removed(),
		);
		await loadPasskeys();
	}
</script>

<svelte:head>
	<title>{m.account_security_title()} · {m.common_settings()} · {m.common_app_name()}</title>
</svelte:head>

{#snippet failure(message: string | null)}
	{#if message}
		<Alert variant="error">{message}</Alert>
	{/if}
{/snippet}

{#snippet codes(list: string[])}
	<div class="border-border bg-muted/50 rounded-md border p-4">
		<div class="mb-1 flex items-center justify-between gap-2">
			<p class="text-sm font-medium">{m.account_security_backup_codes()}</p>
			<Button
				variant="outline"
				size="sm"
				aria-label={m.account_security_copy_codes()}
				onclick={() => copyCodes(list)}
			>
				{copied ? m.common_copied() : m.common_copy()}
			</Button>
		</div>
		<p class="text-muted-foreground mb-3 text-xs">{m.account_security_backup_codes_help()}</p>
		<ul class="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm sm:grid-cols-3">
			{#each list as item (item)}
				<li>{item}</li>
			{/each}
		</ul>
	</div>
{/snippet}

<div class="flex flex-col gap-6">
	<section class="border-border rounded-lg border p-6" aria-labelledby="two-factor-heading">
		<div class="mb-4 flex items-start justify-between gap-4">
			<div>
				<h2 id="two-factor-heading" class="text-lg font-semibold">
					{m.account_security_2fa_title()}
				</h2>
				<p class="text-muted-foreground text-sm">{m.account_security_2fa_description()}</p>
			</div>
			<div aria-live="polite">
				{#if twoFactorEnabled}
					<span
						class="shrink-0 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs"
					>
						{m.account_security_2fa_enabled()}
					</span>
				{:else}
					<span class="border-border bg-muted shrink-0 rounded-full border px-2 py-0.5 text-xs">
						{m.account_security_2fa_off()}
					</span>
				{/if}
			</div>
		</div>

		<div class="flex flex-col gap-4">
			{@render failure(twoFactorError)}

			{#if setup}
				<div class="flex flex-col gap-4">
					<div class="flex flex-col gap-4 sm:flex-row">
						<!-- The SVG is generated locally by uqr from our own otpauth URI, so rendering it as raw HTML is safe. -->
						<div
							class="border-border size-48 shrink-0 overflow-hidden rounded-md border bg-white p-2 [&>svg]:size-full"
						>
							{@html renderSVG(setup.totpURI)}
						</div>
						<div class="flex flex-col gap-2 text-sm">
							<p>{m.account_security_scan_qr()}</p>
							{#if setup.secret}
								<code class="bg-muted rounded-md px-2 py-1 font-mono text-xs break-all select-all">
									{setup.secret}
								</code>
							{:else}
								<p class="text-muted-foreground">{m.account_security_manual_key_unavailable()}</p>
							{/if}
						</div>
					</div>

					{@render codes(setup.backupCodes)}

					<form class="flex flex-col gap-4" onsubmit={verify}>
						<Label>
							{m.account_security_enter_code()}
							<Input
								bind:value={code}
								inputmode="numeric"
								autocomplete="one-time-code"
								pattern={'[0-9]{6}'}
								maxlength={6}
								required
								disabled={twoFactorBusy}
								class="max-w-40 font-mono tracking-widest"
							/>
						</Label>
						<div class="flex gap-2">
							<Button type="submit" disabled={twoFactorBusy}>
								{twoFactorBusy
									? m.account_security_verifying()
									: m.account_security_verify_and_enable()}
							</Button>
							<Button variant="ghost" onclick={cancelSetup} disabled={twoFactorBusy}>
								{m.common_cancel()}
							</Button>
						</div>
					</form>
				</div>
			{:else if prompt}
				<form class="flex flex-col gap-4" onsubmit={submitPassword}>
					<p class="text-sm">{promptCopy[prompt].text}</p>
					<Label>
						{m.common_password()}
						<Input
							bind:value={password}
							type="password"
							autocomplete="current-password"
							required
							disabled={twoFactorBusy}
							class="max-w-sm"
						/>
					</Label>
					<div class="flex gap-2">
						<Button
							type="submit"
							variant={prompt === 'disable' ? 'danger' : 'primary'}
							disabled={twoFactorBusy}
						>
							{twoFactorBusy ? m.account_security_please_wait() : promptCopy[prompt].action}
						</Button>
						<Button variant="ghost" onclick={closePrompt} disabled={twoFactorBusy}>
							{m.common_cancel()}
						</Button>
					</div>
				</form>
			{:else if twoFactorEnabled}
				<div class="flex flex-wrap gap-2">
					<Button variant="secondary" onclick={() => openPrompt('regenerate')}>
						{m.account_security_regenerate_codes()}
					</Button>
					<Button variant="danger" onclick={() => openPrompt('disable')}>
						{m.account_security_disable()}
					</Button>
				</div>
			{:else}
				<div>
					<Button onclick={() => openPrompt('enable')} disabled={!$session.data}>
						{m.account_security_2fa_enable()}
					</Button>
				</div>
			{/if}

			{#if backupCodes && !setup}
				{@render codes(backupCodes)}
			{/if}
		</div>
	</section>

	<section class="border-border rounded-lg border p-6" aria-labelledby="passkeys-heading">
		<h2 id="passkeys-heading" class="text-lg font-semibold">
			{m.account_security_passkeys_title()}
		</h2>
		<p class="text-muted-foreground mb-4 text-sm">{m.account_security_passkeys_description()}</p>

		<div class="flex flex-col gap-4">
			{#if passkeySupport === false}
				<Alert>{m.account_security_passkeys_unsupported()}</Alert>
			{/if}
			{@render failure(passkeyError)}

			{#if passkeysLoading}
				<div role="status" aria-live="polite" class="flex flex-col gap-2">
					<span class="sr-only">{m.account_security_passkeys_loading()}</span>
					{#each placeholderRows as row (row)}
						<Skeleton class="h-14 w-full" />
					{/each}
				</div>
			{:else if passkeysError}
				<div class="flex flex-col gap-2">
					<Alert variant="error">{passkeysError}</Alert>
					<div>
						<Button variant="secondary" size="sm" onclick={loadPasskeys}>
							{m.common_try_again()}
						</Button>
					</div>
				</div>
			{:else if passkeys.length === 0}
				<EmptyState
					class="py-8"
					title={m.account_security_passkeys_empty_title()}
					description={m.account_security_passkeys_empty_description()}
				>
					{#snippet icon()}
						<KeyRoundIcon />
					{/snippet}
				</EmptyState>
			{:else}
				<ul class="border-border divide-border divide-y rounded-md border">
					{#each passkeys as passkey (passkey.id)}
						<li class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
							{#if renamingId === passkey.id}
								<form class="flex flex-1 flex-wrap items-center gap-2" onsubmit={saveRename}>
									<Input
										bind:value={renameValue}
										aria-label={m.account_security_passkey_name()}
										autocomplete="off"
										required
										disabled={rowBusy}
										class="h-8 max-w-xs"
									/>
									<Button type="submit" size="sm" disabled={rowBusy}>
										{rowBusy ? m.common_saving() : m.common_save()}
									</Button>
									<Button variant="ghost" size="sm" onclick={cancelRename} disabled={rowBusy}>
										{m.common_cancel()}
									</Button>
								</form>
							{:else}
								<div class="min-w-0">
									<p class="truncate font-medium">{passkeyLabel(passkey)}</p>
									<p class="text-muted-foreground text-xs">
										{#if passkey.createdAt}
											{m.account_security_passkey_added_on({ date: formatDate(passkey.createdAt) })}
										{:else}
											{m.account_security_passkey_added_unknown()}
										{/if}
									</p>
								</div>
								<div class="flex gap-1">
									<Button
										variant="outline"
										size="sm"
										aria-label={m.account_security_passkey_rename_label({
											name: passkeyLabel(passkey),
										})}
										onclick={() => startRename(passkey)}
										disabled={rowBusy}
									>
										{m.account_security_passkey_rename()}
									</Button>
									<Button
										variant="outline"
										size="sm"
										class="text-destructive"
										aria-label={m.account_security_passkey_remove_label({
											name: passkeyLabel(passkey),
										})}
										onclick={() => (removingPasskey = passkey)}
										disabled={rowBusy}
									>
										{m.common_remove()}
									</Button>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			<form class="flex flex-wrap items-end gap-2" onsubmit={addPasskey}>
				<Label class="min-w-48 flex-1">
					{m.account_security_passkey_name_optional()}
					<Input
						bind:value={newPasskeyName}
						placeholder={m.account_security_passkey_name_placeholder()}
						autocomplete="off"
						disabled={addBusy || passkeySupport === false}
					/>
				</Label>
				<Button
					type="submit"
					variant="secondary"
					disabled={addBusy || passkeySupport !== true || !$session.data}
				>
					{addBusy ? m.account_security_passkey_waiting() : m.account_security_passkey_add()}
				</Button>
			</form>
		</div>
	</section>
</div>

<!-- Remove passkey -->
<Dialog.Root
	open={removingPasskey !== null}
	onOpenChange={(open) => {
		if (!open && !rowBusy) removingPasskey = null;
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>
				{#if removingPasskey?.name}
					{m.account_security_passkey_remove_title_named({ name: removingPasskey.name })}
				{:else}
					{m.account_security_passkey_remove_title()}
				{/if}
			</Dialog.Title>
			<Dialog.Description>{m.account_security_passkey_remove_description()}</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}
					<Button variant="ghost" disabled={rowBusy} {...props}>{m.common_cancel()}</Button>
				{/snippet}
			</Dialog.Close>
			<Button variant="danger" disabled={rowBusy} onclick={removePasskey}>
				{rowBusy ? m.account_security_passkey_removing() : m.account_security_passkey_remove()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
