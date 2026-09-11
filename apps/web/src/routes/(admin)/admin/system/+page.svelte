<script lang="ts">
	import { type SystemStatus, safe } from '@repo/api-client';
	import { Alert, Button, cn } from '@repo/ui';
	import { onMount, untrack } from 'svelte';
	import { api } from '$lib/api';
	import { messageOf } from '$lib/forms';
	import { formatDateTime, formatNumber } from '$lib/i18n';
	import { m } from '$lib/paraglide/messages';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** `3d 2h`, `2h 14m`, `14m`, `40s` — coarse on purpose, the page is a glance. */
	function formatUptime(seconds: number) {
		const days = Math.floor(seconds / 86_400);
		const hours = Math.floor((seconds % 86_400) / 3_600);
		const minutes = Math.floor((seconds % 3_600) / 60);
		if (days > 0) return m.admin_system_uptime_days_hours({ days, hours });
		if (hours > 0) return m.admin_system_uptime_hours_minutes({ hours, minutes });
		if (minutes > 0) return m.admin_system_uptime_minutes({ minutes });
		return m.admin_system_uptime_seconds({ seconds });
	}

	function latency(probe: { ok: boolean; latencyMs: number | null }) {
		return probe.latencyMs === null
			? null
			: m.admin_system_latency({ ms: formatNumber(probe.latencyMs) });
	}

	// Seeded from the load so SSR renders the cards; `untrack` because the initial value is
	// intentional — Refresh goes through `load()`.
	let status = $state<SystemStatus | null>(untrack(() => data.status));
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let fetchedAt = $state<Date | null>(null);

	async function load() {
		loading = true;
		loadError = null;
		const { error, data: result } = await safe(api.admin.system.status());
		loading = false;
		if (error) {
			loadError = messageOf(error);
			return;
		}
		status = result;
		fetchedAt = new Date();
	}

	// The load already fetched the snapshot; only fetch here when it could not.
	onMount(() => {
		if (!status) void load();
	});
</script>

<svelte:head>
	<title>{m.admin_system_title()} · {m.admin_title()} · {m.common_app_name()}</title>
</svelte:head>

{#snippet health(ok: boolean, label: string, detail: string | null = null)}
	<span class="inline-flex items-center gap-2">
		<span
			class={cn('inline-block size-2 rounded-full', ok ? 'bg-success' : 'bg-destructive')}
			aria-hidden="true"
		></span>
		<span class={cn('font-medium', !ok && 'text-destructive')}>{label}</span>
		{#if detail}
			<span class="text-muted-foreground">{detail}</span>
		{/if}
	</span>
{/snippet}

{#snippet row(label: string)}
	<dt class="text-muted-foreground">{label}</dt>
{/snippet}

<div class="mx-auto flex w-full max-w-4xl flex-col gap-6">
	<div class="flex flex-wrap items-end justify-between gap-4">
		<div>
			<h1 class="text-2xl font-semibold">{m.admin_system_title()}</h1>
			<p class="text-muted-foreground text-sm">
				{#if fetchedAt}
					{m.admin_system_snapshot_from({ time: formatDateTime(fetchedAt) })}
				{:else}
					{m.admin_system_description()}
				{/if}
			</p>
		</div>
		<Button variant="secondary" size="sm" disabled={loading} onclick={() => load()}>
			{loading ? m.admin_refreshing() : m.admin_refresh()}
		</Button>
	</div>

	{#if loadError}
		<div class="flex flex-col gap-2">
			<Alert variant="error">{loadError}</Alert>
			<div>
				<Button variant="secondary" size="sm" onclick={() => load()}>{m.common_try_again()}</Button>
			</div>
		</div>
	{/if}

	{#if !status}
		{#if !loadError}
			<p class="text-muted-foreground text-sm">{m.admin_system_loading()}</p>
		{/if}
	{:else}
		{@const database = status.database}
		{@const migrations = database.migrations}
		<div class="grid gap-4 sm:grid-cols-2">
			<!-- Build -->
			<section class="border-border rounded-lg border p-6">
				<h2 class="mb-3 text-lg font-semibold">{m.admin_system_build()}</h2>
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
					{@render row(m.admin_system_version())}
					<dd class="font-mono">{status.version}</dd>
					{@render row(m.admin_system_runtime())}
					<dd>{status.runtime}</dd>
					{@render row(m.admin_system_environment())}
					<dd>{status.environment}</dd>
					{@render row(m.admin_system_started())}
					<dd>{formatDateTime(status.startedAt)}</dd>
					{@render row(m.admin_system_uptime())}
					<dd>{formatUptime(status.uptimeSeconds)}</dd>
				</dl>
			</section>

			<!-- Counts -->
			<section class="border-border rounded-lg border p-6">
				<h2 class="mb-3 text-lg font-semibold">{m.admin_system_counts()}</h2>
				<dl class="grid grid-cols-2 gap-4 text-sm">
					<div>
						<dt class="text-muted-foreground">{m.admin_system_counts_users()}</dt>
						<dd class="text-2xl font-semibold tabular-nums">{formatNumber(status.counts.users)}</dd>
					</div>
				</dl>
			</section>

			<!-- Database -->
			<section class="border-border rounded-lg border p-6">
				<h2 class="mb-3 text-lg font-semibold">{m.admin_system_database()}</h2>
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
					{@render row(m.admin_system_connection())}
					<dd>
						{@render health(
							database.ok,
							database.ok ? m.admin_system_health_ok() : m.admin_system_health_down(),
							latency(database),
						)}
						{#if database.error}
							<span class="text-destructive block text-xs">{database.error}</span>
						{/if}
					</dd>
					{#if migrations}
						{@render row(m.admin_system_migrations())}
						<dd>
							{m.admin_system_migrations_applied({
								applied: formatNumber(migrations.applied),
								shipped: formatNumber(migrations.shipped),
							})}
							{#if migrations.latestApplied}
								<span class="text-muted-foreground block font-mono text-xs">
									{m.admin_system_migrations_latest({ name: migrations.latestApplied })}
								</span>
							{/if}
						</dd>
						{#if migrations.pending.length > 0}
							{@render row(m.admin_system_migrations_pending())}
							<dd class="text-destructive">
								<ul class="font-mono text-xs">
									{#each migrations.pending as name (name)}
										<li>{name}</li>
									{/each}
								</ul>
							</dd>
						{/if}
						{#if migrations.unknown > 0}
							{@render row(m.admin_system_migrations_unknown())}
							<dd class="text-destructive">
								{m.admin_system_migrations_unknown_detail({ count: migrations.unknown })}
							</dd>
						{/if}
					{/if}
				</dl>
			</section>

			<!-- Email -->
			<section class="border-border rounded-lg border p-6">
				<h2 class="mb-3 text-lg font-semibold">{m.common_email()}</h2>
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
					{@render row(m.admin_system_email_provider())}
					<dd>{status.email.provider}</dd>
					{@render row(m.admin_system_email_from())}
					<dd class="break-all">{status.email.from || '—'}</dd>
				</dl>
			</section>

			<!-- Auth -->
			<section class="border-border rounded-lg border p-6">
				<h2 class="mb-3 text-lg font-semibold">{m.admin_system_auth()}</h2>
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
					{@render row(m.admin_system_auth_social())}
					<dd>
						{status.auth.socialProviders.length > 0
							? status.auth.socialProviders.join(', ')
							: m.admin_system_none_configured()}
					</dd>
					{@render row(m.admin_system_auth_email_verification())}
					<dd>
						{status.auth.requireEmailVerification ? m.admin_system_required() : m.common_optional()}
					</dd>
				</dl>
			</section>
		</div>
	{/if}
</div>
