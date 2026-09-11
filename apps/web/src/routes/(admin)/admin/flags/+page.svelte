<script lang="ts">
	import {
		type FeatureFlag,
		FlagKeySchema,
		isDefinedError,
		type ORPCError,
		safe,
	} from '@repo/api-client';
	import { Alert, Button, cn, Input, Label } from '@repo/ui';
	import { onMount, untrack } from 'svelte';
	import { api } from '$lib/api';
	import { issueMessage, messageOf } from '$lib/forms';
	import { m } from '$lib/paraglide/messages';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Action = 'toggle' | 'edit' | 'delete';
	type Notice = { variant: 'info' | 'success' | 'error'; text: string } | null;

	// ---- List ------------------------------------------------------------------
	// Seeded from the load so SSR renders the list; `untrack` because the initial value is
	// intentional — later changes come from `load()` and `put()`.
	let flags = $state<FeatureFlag[] | null>(untrack(() => data.flags));
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let listNotice = $state<Notice>(null);

	async function load() {
		loading = true;
		loadError = null;
		const { error, data: list } = await safe(api.admin.flags.list());
		loading = false;
		if (error) {
			loadError = messageOf(error);
			return;
		}
		flags = list;
	}

	// The load already fetched the list; only fetch here when it could not.
	onMount(() => {
		if (!flags) void load();
	});

	/** Replace (or insert, keeping the API's key order) the flag the server just returned. */
	function put(flag: FeatureFlag) {
		const list = flags ?? [];
		flags = list.some((f) => f.key === flag.key)
			? list.map((f) => (f.key === flag.key ? flag : f))
			: [...list, flag].sort((a, b) => a.key.localeCompare(b.key));
	}

	// ---- New flag --------------------------------------------------------------
	let newKey = $state('');
	let newDescription = $state('');
	let newEnabled = $state(false);
	let createBusy = $state(false);
	let createNotice = $state<Notice>(null);

	const keyCheck = $derived(FlagKeySchema.safeParse(newKey));
	const keyError = $derived.by(() => {
		if (newKey.length === 0 || keyCheck.success) return null;
		const issue = keyCheck.error.issues[0];
		if (!issue) return m.admin_flags_key_invalid();
		// The schema is a bare string, so `issueMessage` cannot tell it is a flag key; name the
		// format here and leave the length rules to it.
		if (issue.code === 'invalid_format') return m.validation_flag_key();
		return issueMessage(issue) ?? m.admin_flags_key_invalid();
	});

	async function createFlag(event: SubmitEvent) {
		event.preventDefault();
		if (!keyCheck.success) return;
		const key = keyCheck.data;
		// `upsert` would silently overwrite an existing flag's description and default.
		if (flags?.some((f) => f.key === key)) {
			createNotice = { variant: 'error', text: m.admin_flags_create_exists({ key }) };
			return;
		}
		createBusy = true;
		createNotice = null;
		const { error, data: flag } = await safe(
			api.admin.flags.upsert({ key, description: newDescription.trim(), enabled: newEnabled }),
		);
		createBusy = false;
		if (error) {
			createNotice = { variant: 'error', text: messageOf(error) };
			return;
		}
		put(flag);
		newKey = '';
		newDescription = '';
		newEnabled = false;
		createNotice = { variant: 'success', text: m.admin_flags_create_success({ key: flag.key }) };
	}

	// ---- Per-flag actions ------------------------------------------------------
	let busy = $state<{ key: string; action: Action } | null>(null);
	let editing = $state<string | null>(null);
	let editValue = $state('');
	let deleting = $state<string | null>(null);

	function isBusy(flag: FeatureFlag, action: Action) {
		return busy?.key === flag.key && busy.action === action;
	}

	/** Typed errors get friendlier copy; anything else keeps its message. */
	function notFoundOr(error: ORPCError<string, unknown> | Error, notFound: string) {
		return isDefinedError(error) && error.code === 'NOT_FOUND' ? notFound : messageOf(error);
	}

	async function toggleFlag(flag: FeatureFlag) {
		busy = { key: flag.key, action: 'toggle' };
		listNotice = null;
		const { error, data: updated } = await safe(
			api.admin.flags.upsert({ key: flag.key, enabled: !flag.enabled }),
		);
		busy = null;
		if (error) {
			listNotice = { variant: 'error', text: notFoundOr(error, m.admin_flags_gone()) };
			return;
		}
		put(updated);
		listNotice = {
			variant: 'success',
			text: updated.enabled
				? m.admin_flags_toggle_on_success({ key: flag.key })
				: m.admin_flags_toggle_off_success({ key: flag.key }),
		};
	}

	function startEdit(flag: FeatureFlag) {
		editing = flag.key;
		editValue = flag.description;
	}

	async function saveDescription(event: SubmitEvent, flag: FeatureFlag) {
		event.preventDefault();
		const description = editValue.trim();
		if (description === flag.description) {
			editing = null;
			return;
		}
		busy = { key: flag.key, action: 'edit' };
		listNotice = null;
		const { error, data: updated } = await safe(
			api.admin.flags.upsert({ key: flag.key, description }),
		);
		busy = null;
		if (error) {
			listNotice = { variant: 'error', text: notFoundOr(error, m.admin_flags_gone()) };
			return;
		}
		put(updated);
		editing = null;
		listNotice = {
			variant: 'success',
			text: m.admin_flags_description_updated({ key: flag.key }),
		};
	}

	async function deleteFlag(flag: FeatureFlag) {
		busy = { key: flag.key, action: 'delete' };
		listNotice = null;
		const { error } = await safe(api.admin.flags.delete({ key: flag.key }));
		busy = null;
		deleting = null;
		if (error) {
			listNotice = { variant: 'error', text: notFoundOr(error, m.admin_flags_gone()) };
			return;
		}
		flags = (flags ?? []).filter((f) => f.key !== flag.key);
		listNotice = { variant: 'success', text: m.admin_flags_delete_success({ key: flag.key }) };
	}
</script>

<svelte:head>
	<title>{m.admin_flags_title()} · {m.admin_title()} · {m.common_app_name()}</title>
</svelte:head>

{#snippet notice(value: Notice)}
	{#if value}
		<Alert variant={value.variant}>{value.text}</Alert>
	{/if}
{/snippet}

<div class="mx-auto flex w-full max-w-4xl flex-col gap-6">
	<div>
		<h1 class="text-2xl font-semibold">{m.admin_flags_title()}</h1>
		<p class="text-muted-foreground text-sm">{m.admin_flags_description()}</p>
	</div>

	<!-- New flag -->
	<section class="border-border rounded-lg border p-6">
		<h2 class="text-lg font-semibold">{m.admin_flags_create_title()}</h2>
		<p class="text-muted-foreground mb-4 text-sm">{m.admin_flags_create_description()}</p>
		<form class="flex flex-col gap-4" onsubmit={createFlag}>
			<div class="grid gap-4 sm:grid-cols-[14rem_1fr]">
				<Label>
					{m.admin_flags_key()}
					<Input
						bind:value={newKey}
						name="key"
						autocomplete="off"
						spellcheck={false}
						placeholder={m.admin_flags_key_placeholder()}
						maxlength={64}
						invalid={keyError !== null}
						required
						disabled={createBusy}
					/>
					{#if keyError}
						<span class="text-destructive font-normal">{keyError}</span>
					{/if}
				</Label>
				<Label>
					<!-- `Label` stacks its children, so the hint shares a row with the field name: as a
					     third child it became a line of its own and pushed this `Input` a row below the
					     key field's in the grid. -->
					<span class="flex items-baseline gap-1">
						{m.admin_flags_field_description()}
						<span class="text-muted-foreground font-normal">{m.admin_optional_hint()}</span>
					</span>
					<Input
						bind:value={newDescription}
						name="description"
						autocomplete="off"
						placeholder={m.admin_flags_description_placeholder()}
						maxlength={200}
						disabled={createBusy}
					/>
				</Label>
			</div>
			<label class="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					class="border-border rounded"
					bind:checked={newEnabled}
					disabled={createBusy}
				>
				{m.admin_flags_enabled_by_default()}
			</label>
			{@render notice(createNotice)}
			<div>
				<Button type="submit" disabled={createBusy || !keyCheck.success}>
					{createBusy ? m.common_creating() : m.admin_flags_create_submit()}
				</Button>
			</div>
		</form>
	</section>

	<!-- Flags -->
	<section class="border-border rounded-lg border p-6">
		<div class="mb-4 flex flex-wrap items-start justify-between gap-4">
			<div>
				<h2 class="text-lg font-semibold">{m.admin_flags_list_title()}</h2>
				<p class="text-muted-foreground text-sm">{m.admin_flags_list_description()}</p>
			</div>
			<Button variant="secondary" size="sm" disabled={loading} onclick={() => load()}>
				{loading ? m.common_loading() : m.admin_refresh()}
			</Button>
		</div>

		<div class="flex flex-col gap-4">
			{@render notice(listNotice)}

			{#if loadError}
				<div class="flex flex-col gap-2">
					<Alert variant="error">{loadError}</Alert>
					<div>
						<Button variant="secondary" size="sm" onclick={() => load()}>
							{m.common_try_again()}
						</Button>
					</div>
				</div>
			{:else if !flags}
				<p class="text-muted-foreground text-sm">{m.admin_flags_loading()}</p>
			{:else if flags.length === 0}
				<p class="text-muted-foreground text-sm">{m.admin_flags_empty()}</p>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each flags as flag (flag.key)}
						<li class="border-border rounded-md border">
							<div class="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
								<div class="flex min-w-0 flex-1 flex-col gap-1">
									<div class="flex flex-wrap items-center gap-2">
										<span class="font-mono text-sm font-medium">{flag.key}</span>
										<span
											class={cn(
												'rounded-full border px-2 py-0.5 text-xs',
												flag.enabled
													? 'border-success/40 bg-success/10'
													: 'border-border bg-muted text-muted-foreground',
											)}
										>
											{flag.enabled ? m.admin_flags_default_on() : m.admin_flags_default_off()}
										</span>
									</div>
									{#if editing === flag.key}
										<form
											class="flex flex-wrap items-center gap-2"
											onsubmit={(event) => saveDescription(event, flag)}
										>
											<Input
												class="h-8 max-w-md"
												bind:value={editValue}
												aria-label={m.admin_flags_description_label({ key: flag.key })}
												autocomplete="off"
												maxlength={200}
												disabled={isBusy(flag, 'edit')}
											/>
											<Button type="submit" size="sm" disabled={busy !== null}>
												{isBusy(flag, 'edit') ? m.common_saving() : m.common_save()}
											</Button>
											<Button
												variant="ghost"
												size="sm"
												disabled={busy !== null}
												onclick={() => (editing = null)}
											>
												{m.common_cancel()}
											</Button>
										</form>
									{:else}
										<p class="text-muted-foreground text-sm">
											{flag.description || m.admin_flags_no_description()}
											<button
												type="button"
												class="hover:text-foreground ml-1 underline"
												disabled={busy !== null}
												onclick={() => startEdit(flag)}
											>
												{m.common_edit()}
											</button>
										</p>
									{/if}
								</div>
								<div class="flex items-center gap-1">
									<Button
										variant="secondary"
										size="sm"
										disabled={busy !== null}
										onclick={() => toggleFlag(flag)}
									>
										{#if isBusy(flag, 'toggle')}
											{m.common_saving()}
										{:else if flag.enabled}
											{m.admin_flags_disable()}
										{:else}
											{m.admin_flags_enable()}
										{/if}
									</Button>
									{#if deleting === flag.key}
										<Button
											variant="danger"
											size="sm"
											disabled={busy !== null}
											onclick={() => deleteFlag(flag)}
										>
											{isBusy(flag, 'delete') ? m.common_deleting() : m.admin_confirm()}
										</Button>
										<Button
											variant="ghost"
											size="sm"
											disabled={busy !== null}
											onclick={() => (deleting = null)}
										>
											{m.common_cancel()}
										</Button>
									{:else}
										<Button
											variant="outline"
											size="sm"
											class="text-destructive"
											disabled={busy !== null}
											onclick={() => (deleting = flag.key)}
										>
											{m.common_delete()}
										</Button>
									{/if}
								</div>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>
</div>
