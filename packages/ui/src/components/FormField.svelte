<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../utils.js';
	import Label from './Label.svelte';

	/** What the control needs to be labelled and described correctly. */
	type FieldControl = { id: string; describedBy: string | undefined; invalid: boolean };

	interface Props {
		label: string;
		/** Field name in the form's data — also the default id suffix. */
		name: string;
		/** Validation messages for this field (`$errors.<name>`); the first one is shown. */
		errors?: string[];
		/** Help text shown while there is no error. */
		hint?: string;
		/** Override the generated control id (e.g. to focus it from elsewhere). */
		id?: string;
		class?: string;
		/** Rendered at the right of the label — a "Forgot password?" link, for instance. */
		aside?: Snippet;
		/**
		 * The control. Spread what it receives onto the input so the label, the error and the hint
		 * are wired up for assistive technology:
		 *
		 *   {#snippet children({ id, describedBy, invalid })}
		 *     <Input {id} {invalid} aria-describedby={describedBy} bind:value={$form.name} />
		 *   {/snippet}
		 */
		children: Snippet<[FieldControl]>;
	}

	let {
		label,
		name,
		errors,
		hint,
		id: givenId,
		class: className,
		aside,
		children,
	}: Props = $props();

	const uid = $props.id();
	const id = $derived(givenId ?? `${uid}-${name}`);
	const errorId = $derived(`${id}-error`);
	const hintId = $derived(`${id}-hint`);
	const message = $derived(errors?.[0]);
	const invalid = $derived(message !== undefined);
	const describedBy = $derived(invalid ? errorId : hint ? hintId : undefined);
</script>

<div class={cn('flex flex-col gap-1.5', className)}>
	{#if aside}
		<div class="flex items-center justify-between gap-3">
			<Label for={id}>{label}</Label>
			{@render aside()}
		</div>
	{:else}
		<Label for={id}>{label}</Label>
	{/if}
	{@render children({ id, describedBy, invalid })}
	{#if message}
		<p id={errorId} class="text-destructive text-xs">{message}</p>
	{:else if hint}
		<p id={hintId} class="text-muted-foreground text-xs">{hint}</p>
	{/if}
</div>
