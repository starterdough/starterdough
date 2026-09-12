<script lang="ts">
	import { Alert, Button, Input, Label } from '@repo/ui';
	import { toast } from 'svelte-sonner';
	import { authClient } from '$lib/auth';
	import LocaleSwitcher from '$lib/components/LocaleSwitcher.svelte';
	import { messageOf } from '$lib/forms';
	import { m } from '$lib/paraglide/messages';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const session = authClient.useSession();

	// Live store first (it refreshes after every mutation), the /app layout load's snapshot for the
	// first render: the store cannot resolve during SSR, so the address and its verified badge used
	// to arrive a round trip after hydration.
	const user = $derived($session.data?.user ?? data.session.user);

	/** Inline notices: errors, and follow-up instructions the user must act on. Successes are toasts. */
	type Notice = { variant: 'info' | 'error'; text: string } | null;

	// ---- Profile -------------------------------------------------------------
	// Seeded at init rather than in the effect below: an effect only runs in the browser, so seeding
	// there rendered the inputs empty on the server and filled them in after hydration. Read through
	// one const so the deliberate one-shot read needs a single suppression rather than three.
	// svelte-ignore state_referenced_locally -- initial value; the effect below re-seeds on a new id
	const seed = data.session.user;
	let name = $state(seed.name);
	let image = $state(seed.image ?? '');
	let seededFor = $state<string | null>(seed.id);
	let profileBusy = $state(false);
	let profileError = $state<string | null>(null);

	// Re-seed only when the session turns out to be a different account (impersonation, a switch in
	// another tab); a plain refresh of the same user must not clobber edits.
	$effect(() => {
		if (seededFor !== user.id) {
			seededFor = user.id;
			name = user.name;
			image = user.image ?? '';
		}
	});

	async function saveProfile(event: SubmitEvent) {
		event.preventDefault();
		profileBusy = true;
		profileError = null;
		const trimmedImage = image.trim();
		const result = await authClient.updateUser({
			name: name.trim(),
			image: trimmedImage === '' ? null : trimmedImage,
		});
		profileBusy = false;
		if (result.error) {
			profileError = messageOf(result.error);
			return;
		}
		toast.success(m.account_profile_saved());
	}

	// ---- Email ---------------------------------------------------------------
	let newEmail = $state('');
	let emailBusy = $state(false);
	let emailNotice = $state<Notice>(null);

	async function changeEmail(event: SubmitEvent) {
		event.preventDefault();
		const target = newEmail.trim();
		emailBusy = true;
		emailNotice = null;
		const result = await authClient.changeEmail({
			newEmail: target,
			callbackURL: `${location.origin}/app/settings`,
		});
		emailBusy = false;
		if (result.error) {
			emailNotice = { variant: 'error', text: messageOf(result.error) };
			return;
		}
		newEmail = '';
		toast.success(m.account_email_change_requested());
		// Verified accounts approve the change from the current address; unverified ones
		// receive the verification link at the new address instead.
		emailNotice = {
			variant: 'info',
			text: user.emailVerified
				? m.account_email_confirm_sent({ email: user.email })
				: m.account_email_verify_sent({ email: target }),
		};
	}

	// ---- Password ------------------------------------------------------------
	const minPasswordLength = 8;
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let passwordBusy = $state(false);
	let passwordError = $state<string | null>(null);

	async function changePassword(event: SubmitEvent) {
		event.preventDefault();
		passwordError = null;
		if (newPassword.length < minPasswordLength) {
			passwordError = m.account_password_too_short({ minimum: minPasswordLength });
			return;
		}
		if (newPassword !== confirmPassword) {
			passwordError = m.account_password_mismatch();
			return;
		}
		passwordBusy = true;
		const result = await authClient.changePassword({
			currentPassword,
			newPassword,
			revokeOtherSessions: true,
		});
		passwordBusy = false;
		if (result.error) {
			passwordError = messageOf(result.error);
			return;
		}
		currentPassword = '';
		newPassword = '';
		confirmPassword = '';
		toast.success(m.account_password_changed(), {
			description: m.account_password_changed_description(),
		});
	}

	// ---- Danger zone ---------------------------------------------------------

	/** What the user must type to arm the delete button; deliberately not translated. */
	const deleteKeyword = 'delete';
	let confirmingDelete = $state(false);
	let deleteConfirmation = $state('');
	let deleteBusy = $state(false);
	let deleteNotice = $state<Notice>(null);
	const canDelete = $derived(deleteConfirmation.trim().toLowerCase() === deleteKeyword);

	function cancelDelete() {
		confirmingDelete = false;
		deleteConfirmation = '';
	}

	async function deleteAccount(event: SubmitEvent) {
		event.preventDefault();
		if (!canDelete) return;
		deleteBusy = true;
		deleteNotice = null;
		const result = await authClient.deleteUser({ callbackURL: `${location.origin}/` });
		deleteBusy = false;
		if (result.error) {
			deleteNotice = { variant: 'error', text: messageOf(result.error) };
			return;
		}
		cancelDelete();
		toast.success(m.account_delete_email_sent());
		deleteNotice = { variant: 'info', text: m.account_delete_check_inbox() };
	}
</script>

<svelte:head>
	<title>{m.account_profile_title()} · {m.common_settings()} · {m.common_app_name()}</title>
</svelte:head>

{#snippet notice(value: Notice)}
	{#if value}
		<Alert variant={value.variant}>{value.text}</Alert>
	{/if}
{/snippet}

{#snippet failure(message: string | null)}
	{#if message}
		<Alert variant="error">{message}</Alert>
	{/if}
{/snippet}

<div class="flex flex-col gap-6">
	<section class="border-border rounded-lg border p-6" aria-labelledby="profile-heading">
		<h2 id="profile-heading" class="text-lg font-semibold">{m.account_profile_title()}</h2>
		<p class="text-muted-foreground mb-4 text-sm">{m.account_profile_description()}</p>

		<form class="flex flex-col gap-4" onsubmit={saveProfile}>
			<Label>
				{m.common_name()}
				<Input bind:value={name} autocomplete="name" required disabled={profileBusy} />
			</Label>
			<Label>
				{m.account_profile_avatar_url()}
				<Input
					bind:value={image}
					type="url"
					placeholder="https://example.com/avatar.png"
					disabled={profileBusy}
				/>
			</Label>
			{@render failure(profileError)}
			<div>
				<Button type="submit" disabled={profileBusy || !$session.data}>
					{profileBusy ? m.common_saving() : m.common_save_changes()}
				</Button>
			</div>
		</form>
	</section>

	<section class="border-border rounded-lg border p-6" aria-labelledby="language-heading">
		<h2 id="language-heading" class="text-lg font-semibold">{m.common_language()}</h2>
		<p class="text-muted-foreground mb-4 text-sm">{m.common_language_help()}</p>
		<LocaleSwitcher />
	</section>

	<section class="border-border rounded-lg border p-6" aria-labelledby="email-heading">
		<h2 id="email-heading" class="text-lg font-semibold">{m.common_email()}</h2>
		<p class="text-muted-foreground mb-4 text-sm">{m.account_email_description()}</p>

		<div class="mb-4 flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
			<span class="font-medium">{user.email}</span>
			{#if user.emailVerified}
				<span class="rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs">
					{m.account_email_verified()}
				</span>
			{:else}
				<span class="border-border bg-muted rounded-full border px-2 py-0.5 text-xs">
					{m.account_email_unverified()}
				</span>
			{/if}
		</div>

		<form class="flex flex-col gap-4" onsubmit={changeEmail}>
			<Label>
				{m.account_email_new()}
				<Input
					bind:value={newEmail}
					type="email"
					autocomplete="email"
					required
					disabled={emailBusy}
				/>
			</Label>
			{@render notice(emailNotice)}
			<div>
				<Button type="submit" variant="secondary" disabled={emailBusy || !$session.data}>
					{emailBusy ? m.common_sending() : m.account_email_change()}
				</Button>
			</div>
		</form>
	</section>

	<section class="border-border rounded-lg border p-6" aria-labelledby="password-heading">
		<h2 id="password-heading" class="text-lg font-semibold">{m.common_password()}</h2>
		<p class="text-muted-foreground mb-4 text-sm">{m.account_password_description()}</p>

		<form class="flex flex-col gap-4" onsubmit={changePassword}>
			<Label>
				{m.account_password_current()}
				<Input
					bind:value={currentPassword}
					type="password"
					autocomplete="current-password"
					required
					disabled={passwordBusy}
				/>
			</Label>
			<Label>
				{m.account_password_new()}
				<Input
					bind:value={newPassword}
					type="password"
					autocomplete="new-password"
					minlength={minPasswordLength}
					required
					disabled={passwordBusy}
				/>
			</Label>
			<Label>
				{m.account_password_confirm()}
				<Input
					bind:value={confirmPassword}
					type="password"
					autocomplete="new-password"
					minlength={minPasswordLength}
					required
					invalid={confirmPassword !== '' && confirmPassword !== newPassword}
					disabled={passwordBusy}
				/>
			</Label>
			{@render failure(passwordError)}
			<div>
				<Button type="submit" variant="secondary" disabled={passwordBusy}>
					{passwordBusy ? m.account_password_updating() : m.account_password_update()}
				</Button>
			</div>
		</form>
	</section>

	<section class="border-destructive/40 rounded-lg border p-6" aria-labelledby="danger-heading">
		<h2 id="danger-heading" class="text-destructive text-lg font-semibold">
			{m.account_danger_title()}
		</h2>
		<p class="text-muted-foreground mb-4 text-sm">{m.account_danger_description()}</p>

		{#if confirmingDelete}
			<form class="flex flex-col gap-4" onsubmit={deleteAccount}>
				<Label>
					{m.account_delete_confirm_before()}
					<span class="font-mono">{deleteKeyword}</span>
					{m.account_delete_confirm_after()}
					<Input
						bind:value={deleteConfirmation}
						autocomplete="off"
						spellcheck={false}
						disabled={deleteBusy}
					/>
				</Label>
				{@render notice(deleteNotice)}
				<div class="flex gap-2">
					<Button type="submit" variant="danger" disabled={!canDelete || deleteBusy}>
						{deleteBusy ? m.common_sending() : m.account_delete_permanently()}
					</Button>
					<Button variant="ghost" onclick={cancelDelete} disabled={deleteBusy}>
						{m.common_cancel()}
					</Button>
				</div>
			</form>
		{:else}
			<div class="flex flex-col gap-4">
				{@render notice(deleteNotice)}
				<div>
					<Button variant="danger" onclick={() => (confirmingDelete = true)}>
						{m.account_delete_account()}
					</Button>
				</div>
			</div>
		{/if}
	</section>
</div>
