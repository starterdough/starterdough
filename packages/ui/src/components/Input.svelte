<script lang="ts">
	/**
	 * The app's text-input vocabulary: the shadcn Input plus the `invalid` prop every form uses.
	 * `invalid` is only sugar for `aria-invalid`, which is what the shadcn styling keys off.
	 * File inputs need the shadcn Input directly (`@repo/ui/components/ui/input/index.js`).
	 */
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from 'svelte/elements';
	import { Input as ShadcnInput } from './ui/input/index.js';

	interface Props extends Omit<HTMLInputAttributes, 'type' | 'files' | 'aria-invalid'> {
		/** Marks the field invalid (`aria-invalid`, red border and ring). */
		invalid?: boolean;
		/** The underlying element, for focusing or measuring (`bind:ref`). */
		ref?: HTMLInputElement | null;
		type?: Exclude<HTMLInputTypeAttribute, 'file'>;
	}

	let {
		invalid = false,
		type,
		value = $bindable(),
		ref = $bindable(null),
		...rest
	}: Props = $props();
</script>

<ShadcnInput bind:ref bind:value {type} aria-invalid={invalid || undefined} {...rest} />
