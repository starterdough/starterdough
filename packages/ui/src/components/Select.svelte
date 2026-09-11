<script lang="ts">
	/**
	 * Native `<select>` styled to match the shadcn Input, because the shadcn set has no plain select
	 * (its `select` is a bits-ui listbox with a different API). Keep these classes in step with
	 * `./ui/input/input.svelte`.
	 *
	 * `pr-9`, not `px-2.5`: the `@tailwindcss/forms` base layer draws the chevron at `right 0.5rem`
	 * with `background-size: 1.5em` and reserves `padding-right: 2.5rem` for it — a symmetric `px-*`
	 * utility overrides that reservation and the arrow lands on top of the option text.
	 */
	import type { HTMLSelectAttributes } from 'svelte/elements';
	import { cn } from '../utils.js';

	interface Props extends Omit<HTMLSelectAttributes, 'aria-invalid'> {
		/** Marks the field invalid (`aria-invalid`, red border and ring). */
		invalid?: boolean;
		/** The underlying element, for focusing or measuring (`bind:ref`). */
		ref?: HTMLSelectElement | null;
	}

	let {
		invalid = false,
		class: className,
		value = $bindable(),
		ref = $bindable(null),
		children,
		...rest
	}: Props = $props();
</script>

<select
	bind:this={ref}
	bind:value
	data-slot="select"
	aria-invalid={invalid || undefined}
	class={cn(
		'border-input h-8 w-full min-w-0 rounded-lg border bg-transparent py-1 pl-2.5 pr-9 text-base transition-colors outline-none md:text-sm',
		'focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-3',
		'aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-invalid:ring-3',
		'dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
		'disabled:bg-input/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:disabled:bg-input/80',
		className,
	)}
	{...rest}
>
	{@render children?.()}
</select>

<style>
	/*
	 * The browser paints the open dropdown panel from the *select's* background, and in dark mode
	 * that is `--input` — `oklch(1 0 0 / 35%)`, a translucent white. The panel came out near-white
	 * while the options inherited the near-white dark `--foreground`, leaving the list unreadable.
	 * Naming the panel's own colors keeps the closed control's translucent fill intact.
	 *
	 * `:global`, because the options are passed in through the children snippet and so are scoped
	 * to the consuming component, not this one.
	 */
	select :global(option),
	select :global(optgroup) {
		background-color: var(--popover);
		color: var(--popover-foreground);
	}
</style>
