<script lang="ts">
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import { isAdmin } from '@repo/auth/permissions';
	import { Alert, Button, cn, Dialog, Input, Label, Select } from '@repo/ui';
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { authClient } from '$lib/auth';
	import { messageOf } from '$lib/forms';
	import { formatDate, formatNumber } from '$lib/i18n';
	import { m } from '$lib/paraglide/messages';
	import type { PageData, PageProps } from './$types';

	let { data }: PageProps = $props();

	const session = authClient.useSession();

	type UsersPage = NonNullable<PageData['users']>;
	type AdminUser = UsersPage['users'][number];
	type SearchField = 'email' | 'name';
	type Action = 'role' | 'ban' | 'unban' | 'impersonate' | 'revoke';
	type SelectEvent = Event & { currentTarget: EventTarget & HTMLSelectElement };
	type Notice = { variant: 'info' | 'success' | 'error'; text: string } | null;

	/** Labels for the two built-in roles; anything else (a custom role) is shown as stored. */
	function roleLabel(role: string | undefined) {
		if (role === 'admin') return m.admin_users_role_admin();
		if (role === undefined || role === 'user') return m.admin_users_role_user();
		return role;
	}

	const currentUserId = $derived($session.data?.user.id ?? data.session.user.id);

	// ---- List ------------------------------------------------------------------
	const PAGE = 25;
	// Seeded from the load so SSR renders the first page; `untrack` because the initial value is
	// intentional; every later change goes through `load()`.
	let result = $state<UsersPage | null>(untrack(() => data.users));
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let offset = $state(0);
	let search = $state('');
	let searchField = $state<SearchField>('email');
	/** The search the current page was fetched with; the form fields may have moved on. */
	let applied = $state<{ value: string; field: SearchField } | null>(null);
	/** Guards against a slow response for a previous query overwriting the current one. */
	let loadCounter = 0;

	const users = $derived(result?.users ?? []);
	const total = $derived(result?.total ?? 0);
	const rangeLabel = $derived(
		total === 0
			? m.admin_users_range_empty()
			: m.admin_pagination_range({
					from: formatNumber(offset + 1),
					to: formatNumber(Math.min(offset + PAGE, total)),
					total: formatNumber(total),
				}),
	);

	async function load() {
		const ticket = ++loadCounter;
		loading = true;
		loadError = null;
		const response = await authClient.admin.listUsers({
			query: {
				...(applied
					? {
							searchValue: applied.value,
							searchField: applied.field,
							searchOperator: 'contains' as const,
						}
					: {}),
				limit: PAGE,
				offset,
				sortBy: 'createdAt',
				sortDirection: 'desc',
			},
		});
		if (ticket !== loadCounter) return;
		loading = false;
		if (response.error) {
			loadError = messageOf(response.error);
			return;
		}
		result = response.data;
	}

	// The load already fetched the first page; only fetch here when it could not.
	onMount(() => {
		if (!result) void load();
	});

	function submitSearch(event: SubmitEvent) {
		event.preventDefault();
		const value = search.trim();
		applied = value ? { value, field: searchField } : null;
		offset = 0;
		void load();
	}

	function clearSearch() {
		search = '';
		applied = null;
		offset = 0;
		void load();
	}

	function goTo(next: number) {
		offset = Math.max(0, next);
		void load();
	}

	// ---- Actions ---------------------------------------------------------------
	let busy = $state<{ id: string; action: Action } | null>(null);
	let notice = $state<Notice>(null);
	/** Row with the ban form open. */
	let banning = $state<string | null>(null);
	let banReason = $state('');
	let banDays = $state('');
	/** Bumped after a failed role change so the selects remount with the stored roles. */
	let revision = $state(0);

	function isBusy(user: AdminUser, action: Action) {
		return busy?.id === user.id && busy.action === action;
	}

	/** Runs one admin call for a row, reports the outcome and re-fetches the current page. */
	async function run(
		user: AdminUser,
		action: Action,
		request: () => Promise<{ error: { message?: string | undefined } | null }>,
		success: string,
	) {
		busy = { id: user.id, action };
		notice = null;
		const response = await request();
		if (response.error) {
			busy = null;
			notice = { variant: 'error', text: messageOf(response.error) };
			return false;
		}
		notice = { variant: 'success', text: success };
		await load();
		busy = null;
		return true;
	}

	async function changeRole(user: AdminUser, event: SelectEvent) {
		const role = event.currentTarget.value;
		if ((role !== 'user' && role !== 'admin') || role === (user.role ?? 'user')) return;
		const ok = await run(
			user,
			'role',
			() => authClient.admin.setRole({ userId: user.id, role }),
			role === 'admin'
				? m.admin_users_role_changed_admin({ email: user.email })
				: m.admin_users_role_changed_user({ email: user.email }),
		);
		if (!ok) revision += 1;
	}

	function startBan(user: AdminUser) {
		banning = user.id;
		banReason = '';
		banDays = '';
	}

	async function ban(event: SubmitEvent, user: AdminUser) {
		event.preventDefault();
		const reason = banReason.trim();
		const days = Number(banDays);
		const expires = Number.isFinite(days) && days > 0;
		const ok = await run(
			user,
			'ban',
			() =>
				authClient.admin.banUser({
					userId: user.id,
					...(reason ? { banReason: reason } : {}),
					...(expires ? { banExpiresIn: Math.round(days * 86_400) } : {}),
				}),
			expires
				? m.admin_users_ban_success_days({ email: user.email, count: days })
				: m.admin_users_ban_success({ email: user.email }),
		);
		if (ok) banning = null;
	}

	function unban(user: AdminUser) {
		return run(
			user,
			'unban',
			() => authClient.admin.unbanUser({ userId: user.id }),
			m.admin_users_unban_success({ email: user.email }),
		);
	}

	/**
	 * Both of these act on someone else's account without warning them (one signs every device
	 * out, the other takes over their session), so, like every other destructive action in the
	 * app, they are confirmed rather than fired on the first click.
	 */
	let confirmingRevoke = $state<AdminUser | null>(null);
	let confirmingImpersonate = $state<AdminUser | null>(null);

	async function revokeSessions() {
		const user = confirmingRevoke;
		if (!user) return;
		const ok = await run(
			user,
			'revoke',
			() => authClient.admin.revokeUserSessions({ userId: user.id }),
			m.admin_users_revoke_success({ email: user.email }),
		);
		if (ok) confirmingRevoke = null;
	}

	async function impersonate() {
		const user = confirmingImpersonate;
		if (!user) return;
		busy = { id: user.id, action: 'impersonate' };
		notice = null;
		const response = await authClient.admin.impersonateUser({ userId: user.id });
		if (response.error) {
			busy = null;
			confirmingImpersonate = null;
			notice = { variant: 'error', text: messageOf(response.error) };
			return;
		}
		// The browser's cookie now belongs to the target user; the app shell shows the banner with
		// the Stop button that restores this admin session.
		await goto('/app', { invalidateAll: true });
	}
</script>

<svelte:head>
	<title>{m.admin_users_title()} · {m.admin_title()} · {m.common_app_name()}</title>
</svelte:head>

{#snippet roleBadge(role: string | undefined)}
	{@const admin = isAdmin(role)}
	<span
		class={cn(
			'rounded-full border px-2 py-0.5 text-xs',
			admin ? 'border-primary bg-primary text-primary-foreground font-medium' : 'border-border bg-muted',
		)}
	>
		{roleLabel(role)}
	</span>
{/snippet}

<div class="mx-auto flex w-full max-w-6xl flex-col gap-6">
	<div class="flex flex-wrap items-end justify-between gap-4">
		<div>
			<h1 class="text-2xl font-semibold">{m.admin_users_title()}</h1>
			<p class="text-muted-foreground text-sm">{m.admin_users_description()}</p>
		</div>
		<Button variant="secondary" size="sm" disabled={loading} onclick={() => load()}>
			{loading ? m.common_loading() : m.admin_refresh()}
		</Button>
	</div>

	<form class="flex flex-wrap items-end gap-3" onsubmit={submitSearch}>
		<Label class="min-w-64 flex-1">
			{m.common_search()}
			<Input
				bind:value={search}
				type="search"
				name="search"
				autocomplete="off"
				placeholder={searchField === 'email'
					? m.admin_users_search_placeholder_email()
					: m.admin_users_search_placeholder_name()}
			/>
		</Label>
		<Label class="w-32">
			{m.admin_users_search_field()}
			<Select bind:value={searchField} name="field">
				<option value="email">{m.common_email()}</option>
				<option value="name">{m.common_name()}</option>
			</Select>
		</Label>
		<Button type="submit" variant="secondary" disabled={loading}>{m.common_search()}</Button>
		{#if applied}
			<Button variant="outline" disabled={loading} onclick={clearSearch}>{m.admin_clear()}</Button>
		{/if}
	</form>

	<div class="flex flex-col gap-4">
		{#if notice}
			<Alert variant={notice.variant}>{notice.text}</Alert>
		{/if}

		{#if loadError}
			<div class="flex flex-col gap-2">
				<Alert variant="error">{loadError}</Alert>
				<div>
					<Button variant="secondary" size="sm" onclick={() => load()}>
						{m.common_try_again()}
					</Button>
				</div>
			</div>
		{:else if !result}
			<p class="text-muted-foreground text-sm">{m.admin_users_loading()}</p>
		{:else if users.length === 0}
			<p class="text-muted-foreground text-sm">{m.admin_users_empty()}</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-muted-foreground border-border text-left [&_tr]:border-b">
						<tr>
							<th scope="col" class="py-2 pr-4 font-medium">{m.common_email()}</th>
							<th scope="col" class="py-2 pr-4 font-medium">{m.common_name()}</th>
							<th scope="col" class="py-2 pr-4 font-medium">{m.admin_users_column_role()}</th>
							<th scope="col" class="py-2 pr-4 font-medium">{m.admin_users_column_status()}</th>
							<th scope="col" class="py-2 pr-4 font-medium">{m.admin_users_column_joined()}</th>
							<th scope="col" class="py-2 text-right font-medium">{m.common_actions()}</th>
						</tr>
					</thead>
					{#key revision}
						<tbody class="divide-border divide-y">
							{#each users as user (user.id)}
								{@const isSelf = user.id === currentUserId}
								{@const rowBusy = busy !== null}
								<tr class="align-top">
									<td class="py-2 pr-4">
										<span class="inline-flex items-center gap-2 align-middle">
											<UserRoundIcon
												class="text-muted-foreground size-4 shrink-0"
												aria-hidden="true"
											/>
											<span class="font-medium">{user.email}</span>
										</span>
										{#if isSelf}
											<span
												class="border-border bg-muted ml-2 rounded-full border px-2 py-0.5 text-xs"
											>
												{m.admin_users_you()}
											</span>
										{/if}
									</td>
									<td class="py-2 pr-4">
										{#if user.name}
											{user.name}
										{:else}
											<span class="text-muted-foreground">—</span>
										{/if}
									</td>
									<td class="py-2 pr-4">{@render roleBadge(user.role)}</td>
									<td class="py-2 pr-4">
										{#if user.banned}
											<span class="text-destructive font-medium"
												>{m.admin_users_status_banned()}</span
											>
											{#if user.banReason}
												<span class="text-muted-foreground block text-xs">{user.banReason}</span>
											{/if}
											{#if user.banExpires}
												<span class="text-muted-foreground block text-xs">
													{m.admin_users_banned_until({ date: formatDate(user.banExpires) })}
												</span>
											{/if}
										{:else if user.emailVerified}
											{m.admin_users_status_verified()}
										{:else}
											<span class="text-muted-foreground">{m.admin_users_status_unverified()}</span>
										{/if}
									</td>
									<td class="py-2 pr-4 whitespace-nowrap">{formatDate(user.createdAt)}</td>
									<td class="py-2 text-right whitespace-nowrap">
										{#if !isSelf}
											<div class="flex items-center justify-end gap-1">
												<Select
													class="h-8 w-24"
													aria-label={m.admin_users_role_select_label({ email: user.email })}
													value={user.role ?? 'user'}
													disabled={rowBusy}
													onchange={(event) => changeRole(user, event)}
												>
													<option value="user">{m.admin_users_role_user()}</option>
													<option value="admin">{m.admin_users_role_admin()}</option>
													{#if user.role && user.role !== 'user' && user.role !== 'admin'}
														<option value={user.role}>{user.role}</option>
													{/if}
												</Select>
												<Button
													variant="outline"
													size="sm"
													disabled={rowBusy || isAdmin(user.role)}
													onclick={() => (confirmingImpersonate = user)}
												>
													{isBusy(user, 'impersonate')
														? m.admin_users_impersonating()
														: m.admin_users_impersonate()}
												</Button>
												<Button
													variant="outline"
													size="sm"
													disabled={rowBusy}
													onclick={() => (confirmingRevoke = user)}
												>
													{isBusy(user, 'revoke')
														? m.admin_users_revoking()
														: m.admin_users_revoke_sessions()}
												</Button>
												{#if user.banned}
													<Button
														variant="outline"
														size="sm"
														disabled={rowBusy}
														onclick={() => unban(user)}
													>
														{isBusy(user, 'unban') ? m.admin_users_unbanning() : m.admin_users_unban()}
													</Button>
												{:else if banning !== user.id}
													<Button
														variant="outline"
														size="sm"
														class="text-destructive"
														disabled={rowBusy}
														onclick={() => startBan(user)}
													>
														{m.admin_users_ban()}
													</Button>
												{/if}
											</div>
										{/if}
									</td>
								</tr>
								{#if banning === user.id && !user.banned}
									<tr class="bg-muted/40">
										<td colspan="6" class="px-3 py-3">
											<form
												class="flex flex-wrap items-end gap-3"
												onsubmit={(event) => ban(event, user)}
											>
												<Label class="min-w-64 flex-1">
													<span class="flex items-baseline gap-1">
														{m.admin_users_ban_reason()}
														<span class="text-muted-foreground font-normal"
															>{m.admin_optional_hint()}</span
														>
													</span>
													<Input
														class="h-8"
														bind:value={banReason}
														autocomplete="off"
														maxlength={200}
														placeholder={m.admin_users_ban_reason_placeholder()}
														disabled={rowBusy}
													/>
												</Label>
												<Label class="w-44">
													<span class="flex items-baseline gap-1">
														{m.admin_users_ban_expires()}
														<span class="text-muted-foreground font-normal"
															>{m.admin_optional_hint()}</span
														>
													</span>
													<Input
														class="h-8"
														bind:value={banDays}
														type="number"
														min={1}
														step={1}
														placeholder={m.admin_users_ban_expires_placeholder()}
														disabled={rowBusy}
													/>
												</Label>
												<Button type="submit" variant="danger" size="sm" disabled={rowBusy}>
													{isBusy(user, 'ban')
														? m.admin_users_banning()
														: m.admin_users_ban_submit({ email: user.email })}
												</Button>
												<Button
													variant="ghost"
													size="sm"
													disabled={rowBusy}
													onclick={() => (banning = null)}
												>
													{m.common_cancel()}
												</Button>
											</form>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					{/key}
				</table>
			</div>
			<div class="flex flex-wrap items-center justify-between gap-2 text-sm">
				<span class="text-muted-foreground">{rangeLabel}</span>
				<div class="flex gap-1">
					<Button
						variant="secondary"
						size="sm"
						disabled={loading || offset === 0}
						onclick={() => goTo(offset - PAGE)}
					>
						{m.admin_pagination_previous()}
					</Button>
					<Button
						variant="secondary"
						size="sm"
						disabled={loading || offset + PAGE >= total}
						onclick={() => goTo(offset + PAGE)}
					>
						{m.admin_pagination_next()}
					</Button>
				</div>
			</div>
		{/if}
	</div>
</div>

<!-- Revoke every session -->
<Dialog.Root
	open={confirmingRevoke !== null}
	onOpenChange={(open) => {
		if (!open && busy === null) confirmingRevoke = null;
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>
				{m.admin_users_revoke_confirm_title({ email: confirmingRevoke?.email ?? '' })}
			</Dialog.Title>
			<Dialog.Description>{m.admin_users_revoke_confirm_description()}</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}
					<Button variant="ghost" disabled={busy !== null} {...props}>{m.common_cancel()}</Button>
				{/snippet}
			</Dialog.Close>
			<Button variant="danger" disabled={busy !== null} onclick={revokeSessions}>
				{busy !== null ? m.admin_users_revoking() : m.admin_users_revoke_sessions()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Sign in as this user -->
<Dialog.Root
	open={confirmingImpersonate !== null}
	onOpenChange={(open) => {
		if (!open && busy === null) confirmingImpersonate = null;
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>
				{m.admin_users_impersonate_confirm_title({ email: confirmingImpersonate?.email ?? '' })}
			</Dialog.Title>
			<Dialog.Description>{m.admin_users_impersonate_confirm_description()}</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}
					<Button variant="ghost" disabled={busy !== null} {...props}>{m.common_cancel()}</Button>
				{/snippet}
			</Dialog.Close>
			<Button disabled={busy !== null} onclick={impersonate}>
				{busy !== null ? m.admin_users_impersonating() : m.admin_users_impersonate()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
