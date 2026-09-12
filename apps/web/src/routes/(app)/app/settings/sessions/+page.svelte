<script lang="ts">
	import MonitorSmartphoneIcon from '@lucide/svelte/icons/monitor-smartphone';
	import { Alert, Button, Dialog, EmptyState, Skeleton } from '@repo/ui';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { authClient } from '$lib/auth';
	import { messageOf } from '$lib/forms';
	import { formatDateTime } from '$lib/i18n';
	import { m } from '$lib/paraglide/messages';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const session = authClient.useSession();

	// `ReturnType<>` on the generic client methods collapses to `any`; `$Infer` keeps the real shape.
	type FullSessionRow = (typeof authClient.$Infer)['Session']['session'];
	/**
	 * A row as this page displays it. `token` is optional because the seed from `+page.ts` has none:
	 * it is a bearer credential and must not reach the HTML (see the load). `load()` below refills it
	 * from the client, which is what arms revocation, so treat it as "not here yet", not "gone".
	 */
	type SessionRow = Omit<FullSessionRow, 'token'> & { token?: string };

	const placeholderRows = [0, 1, 2];

	/** Read once, not derived: `load()` owns the list from the first refresh onwards. */
	// svelte-ignore state_referenced_locally -- initial value; `load()` keeps it live
	const seededSessions = data.sessions;
	let sessions = $state<SessionRow[]>(seededSessions ?? []);
	// The load has the rows on the first render; the skeleton rows are now only for a failed load.
	let loading = $state(seededSessions === null);
	let loadError = $state<string | null>(null);
	let actionError = $state<string | null>(null);
	/** Id of the session currently being revoked, or `'others'` for the bulk action. */
	let busy = $state<string | null>(null);
	/** Session awaiting confirmation in the revoke dialog. */
	let revoking = $state<SessionRow | null>(null);
	let confirmingOthers = $state(false);

	// Ids, not tokens: the seeded rows have no token to compare. Live store first (it follows a
	// sign-out elsewhere), the /app layout load's session for the first render, when the store is
	// still null; that load already fetched it, so this page does not ask the API a second time.
	const currentSessionId = $derived($session.data?.session.id ?? data.session.session.id);

	$effect(() => {
		void load();
	});

	async function load() {
		// Unconditional, even when the seed rendered: the seed carries no tokens and revoking needs
		// one. So it must not put skeletons back over rows that are already on screen; only an empty
		// list shows them. `untrack` keeps the mount effect from re-firing every time `load()`
		// replaces `sessions`.
		loading = untrack(() => sessions.length === 0);
		loadError = null;
		const result = await authClient.listSessions();
		if (result.error) {
			loadError = messageOf(result.error);
		} else {
			sessions = [...result.data].sort(
				(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
			);
		}
		loading = false;
	}

	async function revoke() {
		const row = revoking;
		// No token means the client refresh has not landed yet; the button is disabled until it has.
		if (!row?.token) return;
		busy = row.id;
		actionError = null;
		const result = await authClient.revokeSession({ token: row.token });
		busy = null;
		revoking = null;
		if (result.error) {
			actionError = messageOf(result.error);
			return;
		}
		toast.success(m.account_sessions_device_signed_out({ device: deviceLabel(row.userAgent) }));
		await load();
	}

	async function revokeOthers() {
		busy = 'others';
		actionError = null;
		const result = await authClient.revokeOtherSessions();
		busy = null;
		confirmingOthers = false;
		if (result.error) {
			actionError = messageOf(result.error);
			return;
		}
		toast.success(m.account_sessions_others_signed_out());
		await load();
	}

	/** Coarse "browser on OS" label; anything unrecognised falls back to "Unknown device". */
	function deviceLabel(userAgent: string | null | undefined) {
		if (!userAgent) return m.account_sessions_unknown_device();
		const ua = userAgent;
		let browser: string | null = null;
		if (ua.includes('Edg/')) browser = 'Edge';
		else if (ua.includes('OPR/') || ua.includes('Opera')) browser = 'Opera';
		else if (ua.includes('Firefox/')) browser = 'Firefox';
		else if (ua.includes('Chrome/') || ua.includes('CriOS/')) browser = 'Chrome';
		else if (ua.includes('Safari/')) browser = 'Safari';
		else if (ua.startsWith('curl/')) browser = 'curl';

		let os: string | null = null;
		if (ua.includes('Windows')) os = 'Windows';
		else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
		else if (ua.includes('Mac OS X') || ua.includes('Macintosh')) os = 'macOS';
		else if (ua.includes('Android')) os = 'Android';
		else if (ua.includes('CrOS')) os = 'ChromeOS';
		else if (ua.includes('Linux')) os = 'Linux';

		if (browser && os) return m.account_sessions_device_on_os({ browser, os });
		return browser ?? os ?? m.account_sessions_unknown_device();
	}

	function formatDate(value: Date | string | null | undefined) {
		if (!value) return '—';
		return formatDateTime(value);
	}

	const otherSessions = $derived(sessions.filter((row) => row.id !== currentSessionId));
</script>

<svelte:head>
	<title>{m.account_sessions_title()} · {m.common_settings()} · {m.common_app_name()}</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<section class="border-border rounded-lg border p-6" aria-labelledby="sessions-heading">
		<div class="mb-4 flex flex-wrap items-start justify-between gap-4">
			<div>
				<h2 id="sessions-heading" class="text-lg font-semibold">{m.account_sessions_heading()}</h2>
				<p class="text-muted-foreground text-sm">{m.account_sessions_description()}</p>
			</div>
			<Button
				variant="secondary"
				size="sm"
				onclick={() => (confirmingOthers = true)}
				disabled={busy !== null || loading || otherSessions.length === 0}
			>
				{busy === 'others' ? m.account_sessions_signing_out() : m.account_sessions_sign_out_others()}
			</Button>
		</div>

		<div class="flex flex-col gap-4">
			{#if actionError}
				<Alert variant="error">{actionError}</Alert>
			{/if}

			{#if loading}
				<div role="status" aria-live="polite" class="flex flex-col gap-2">
					<span class="sr-only">{m.account_sessions_loading()}</span>
					{#each placeholderRows as row (row)}
						<Skeleton class="h-10 w-full" />
					{/each}
				</div>
			{:else if loadError}
				<div class="flex flex-col gap-2">
					<Alert variant="error">{loadError}</Alert>
					<div>
						<Button variant="secondary" size="sm" onclick={load}>{m.common_try_again()}</Button>
					</div>
				</div>
			{:else if sessions.length === 0}
				<EmptyState
					class="py-8"
					title={m.account_sessions_empty_title()}
					description={m.account_sessions_empty_description()}
				>
					{#snippet icon()}
						<MonitorSmartphoneIcon />
					{/snippet}
				</EmptyState>
			{:else}
				<!-- Scrollable on narrow screens; the only button may be disabled → the region is a tab stop (WCAG 2.1.1). -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<!-- biome-ignore-start lint/a11y/noNoninteractiveTabindex: keyboard access to a scrollable table region -->
				<section
					class="focus-visible:ring-ring overflow-x-auto rounded-md focus-visible:ring-2 focus-visible:outline-none"
					aria-labelledby="sessions-heading"
					tabindex="0"
				>
					<!-- biome-ignore-end lint/a11y/noNoninteractiveTabindex: keyboard access to a scrollable table region -->
					<table class="w-full text-sm">
						<thead class="text-muted-foreground border-border text-left [&_tr]:border-b">
							<tr>
								<th scope="col" class="py-2 pr-4 font-medium">{m.account_sessions_col_device()}</th>
								<th scope="col" class="py-2 pr-4 font-medium">{m.account_sessions_col_ip()}</th>
								<th scope="col" class="py-2 pr-4 font-medium">
									{m.account_sessions_col_created()}
								</th>
								<th scope="col" class="py-2 pr-4 font-medium">
									{m.account_sessions_col_expires()}
								</th>
								<th scope="col" class="py-2 text-right font-medium">{m.common_actions()}</th>
							</tr>
						</thead>
						<tbody class="divide-border divide-y">
							{#each sessions as row (row.id)}
								{@const isCurrent = row.id === currentSessionId}
								<tr>
									<td class="py-2 pr-4">
										<span class="inline-flex items-center gap-2 align-middle">
											<MonitorSmartphoneIcon
												class="text-muted-foreground size-4 shrink-0"
												aria-hidden="true"
											/>
											<span class="font-medium">{deviceLabel(row.userAgent)}</span>
										</span>
										{#if isCurrent}
											<span
												class="border-border bg-muted ml-2 rounded-full border px-2 py-0.5 text-xs"
											>
												{m.account_sessions_this_device()}
											</span>
										{/if}
									</td>
									<td class="py-2 pr-4 font-mono text-xs">{row.ipAddress || '—'}</td>
									<td class="py-2 pr-4 whitespace-nowrap">{formatDate(row.createdAt)}</td>
									<td class="py-2 pr-4 whitespace-nowrap">{formatDate(row.expiresAt)}</td>
									<td class="py-2 text-right">
										<Button
											variant="outline"
											size="sm"
											aria-label={m.account_sessions_revoke_label({
												device: deviceLabel(row.userAgent),
											})}
											onclick={() => (revoking = row)}
											disabled={isCurrent || busy !== null || !row.token}
											title={isCurrent
												? m.account_sessions_use_sign_out({ action: m.common_sign_out() })
												: undefined}
										>
											{busy === row.id ? m.account_sessions_revoking() : m.account_sessions_revoke()}
										</Button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</section>
			{/if}
		</div>
	</section>
</div>

<!-- Revoke one session -->
<Dialog.Root
	open={revoking !== null}
	onOpenChange={(open) => {
		if (!open && busy === null) revoking = null;
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>
				{m.account_sessions_revoke_dialog_title({ device: deviceLabel(revoking?.userAgent) })}
			</Dialog.Title>
			<Dialog.Description>
				{m.account_sessions_revoke_dialog_description()}
				{#if revoking?.ipAddress}
					{m.account_sessions_last_seen_from({ ip: revoking.ipAddress })}
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}
					<Button variant="ghost" disabled={busy !== null} {...props}>{m.common_cancel()}</Button>
				{/snippet}
			</Dialog.Close>
			<Button variant="danger" disabled={busy !== null} onclick={revoke}>
				{busy !== null ? m.account_sessions_revoking() : m.account_sessions_revoke_session()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Revoke every other session -->
<Dialog.Root
	open={confirmingOthers}
	onOpenChange={(open) => {
		if (!open && busy === null) confirmingOthers = false;
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{m.account_sessions_sign_out_others_title()}</Dialog.Title>
			<Dialog.Description>
				{m.account_sessions_sign_out_others_description({ count: otherSessions.length })}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}
					<Button variant="ghost" disabled={busy !== null} {...props}>{m.common_cancel()}</Button>
				{/snippet}
			</Dialog.Close>
			<Button variant="danger" disabled={busy !== null} onclick={revokeOthers}>
				{busy === 'others' ? m.account_sessions_signing_out() : m.account_sessions_sign_out_others()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
