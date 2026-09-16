<script lang="ts">
	import {
		type FeatureFlag,
		FeatureFlagUpsertInputSchema,
		isDefinedError,
		type ORPCError,
		safe,
	} from '@repo/api-client';
	import { Alert, Button, cn, FormField, Input } from '@repo/ui';
	import { onMount, untrack } from 'svelte';
	import { defaults, setError, superForm } from 'sveltekit-superforms';
	import { browser } from '$app/environment';
	import { api } from '$lib/api';
	import { messageOf, spaForm, zodForm } from '$lib/forms';
	import { m } from '$lib/paraglide/messages';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Action = 'toggle' | 'edit' | 'delete';
	type Notice = { variant: 'info' | 'success' | 'error'; text: string } | null;

	// ---- List ------------------------------------------------------------------
	// Seeded from the load so SSR renders the list; `untrack` because the initial value is
	// intentional; later changes come from `load()` and `put()`.
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
	let createNotice = $state<Notice>(null);
	let resetAfterCreate = $state(false);

	const create = superForm(
		defaults({ key: '', description: '', enabled: false }, zodForm(FeatureFlagUpsertInputSchema)),
		{
			...spaForm,
			validators: zodForm(FeatureFlagUpsertInputSchema),
			async onUpdate({ form }) {
				if (!form.valid) return;
				const { key, description, enabled } = form.data;
				// `upsert` would silently overwrite an existing flag's description and default.
				if (flags?.some((flag) => flag.key === key)) {
					setError(form, 'key', m.admin_flags_create_exists({ key }));
					return;
				}
				createNotice = null;
				const { error, data: flag } = await safe(
					api.admin.flags.upsert({ key, description: description?.trim(), enabled }),
				);
				if (error) {
					setError(form, messageOf(error));
					return;
				}
				put(flag);
				resetAfterCreate = true;
				createNotice = {
					variant: 'success',
					text: m.admin_flags_create_success({ key: flag.key }),
				};
			},
			onUpdated() {
				// Superforms replaces its stores with the validated submission after `onUpdate` returns.
				// Reset after that replacement so a successful create clears the visible fields.
				if (!resetAfterCreate) return;
				resetAfterCreate = false;
				create.reset({ newState: { key: '', description: '', enabled: false } });
			},
		},
	);
	const {
		form: createForm,
		errors: createErrors,
		enhance: createEnhance,
		submitting: createSubmitting,
	} = create;

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
		<form class="flex flex-col gap-4" method="POST" novalidate use:createEnhance>
			<div class="grid gap-4 sm:grid-cols-[14rem_1fr]">
				<FormField label={m.admin_flags_key()} name="key" errors={$createErrors.key}>
					{#snippet children({ id, describedBy, invalid })}
						<Input
							{id}
							name="key"
							bind:value={$createForm.key}
							{invalid}
							aria-describedby={describedBy}
							autocomplete="off"
							spellcheck={false}
							placeholder={m.admin_flags_key_placeholder()}
							maxlength={64}
							disabled={$createSubmitting}
						/>
					{/snippet}
				</FormField>
				<FormField
					label={m.admin_flags_field_description()}
					name="description"
					errors={$createErrors.description}
					hint={m.admin_optional_hint()}
				>
					{#snippet children({ id, describedBy, invalid })}
						<Input
							{id}
							name="description"
							bind:value={$createForm.description}
							{invalid}
							aria-describedby={describedBy}
							autocomplete="off"
							placeholder={m.admin_flags_description_placeholder()}
							maxlength={200}
							disabled={$createSubmitting}
						/>
					{/snippet}
				</FormField>
			</div>
			<label class="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					class="border-border rounded"
					bind:checked={$createForm.enabled}
					disabled={$createSubmitting}
				>
				{m.admin_flags_enabled_by_default()}
			</label>
			{#if $createErrors._errors?.length}
				<Alert variant="error">{$createErrors._errors[0]}</Alert>
			{/if}
			{@render notice(createNotice)}
			<div>
				<Button type="submit" disabled={!browser || $createSubmitting}>
					{$createSubmitting ? m.common_creating() : m.admin_flags_create_submit()}
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
							<div class="flex flex-col items-start gap-3 px-4 py-3 sm:flex-row sm:justify-between">
								<div class="flex w-full min-w-0 flex-1 flex-col gap-1 sm:w-auto">
									<div class="flex flex-wrap items-center gap-2">
										<span class="break-all font-mono text-sm font-medium">{flag.key}</span>
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
								<div class="flex flex-wrap items-center gap-1">
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
