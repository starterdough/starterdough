<script lang="ts">
	import type { HTMLLabelAttributes } from 'svelte/elements';
	import { cn } from '../utils.js';

	let { class: className, children, ...rest }: HTMLLabelAttributes = $props();
</script>

<!-- biome-ignore lint/a11y/noLabelWithoutControl: the control is rendered through the children snippet -->
<label class={cn('flex flex-col gap-1.5 text-sm font-medium', className)} {...rest}>
	{@render children?.()}
</label>
