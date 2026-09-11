<script lang="ts">
	import { cn } from '@repo/ui/utils.js';
	import { Command as CommandPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: CommandPrimitive.ListProps = $props();
</script>

<!--
	Diverges from the registry: the Viewport is what bits-ui points the input's `aria-controls` at
	(omitting it fails axe `aria-required-attr`), and a scrollable region with no focusable content
	needs to be a tab stop of its own (WCAG 2.1.1) — items are highlighted, not focused.
-->
<CommandPrimitive.List
	bind:ref
	data-slot="command-list"
	tabindex={0}
	class={cn(
		'no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto rounded-md outline-none',
		'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset',
		className,
	)}
	{...restProps}
>
	<CommandPrimitive.Viewport> {@render children?.()} </CommandPrimitive.Viewport>
</CommandPrimitive.List>
