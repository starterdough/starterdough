<script lang="ts">
	import { cn, type WithoutChildrenOrChild } from '@repo/ui/utils.js';
	import { Popover as PopoverPrimitive } from 'bits-ui';
	import type { ComponentProps } from 'svelte';
	import PopoverPortal from './popover-portal.svelte';

	let {
		ref = $bindable(null),
		class: className,
		sideOffset = 4,
		align = 'center',
		portalProps,
		...restProps
	}: PopoverPrimitive.ContentProps & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof PopoverPortal>>;
	} = $props();

	// Diverges from the registry, which sets no height bound: a tall popover ran off the window.
	// `max-h` is the space Floating UI's size middleware leaves on the side it opens to (the variable
	// the dropdown menu uses too), and the content scrolls within it.
</script>

<PopoverPortal {...portalProps}>
	<PopoverPrimitive.Content
		bind:ref
		data-slot="popover-content"
		{sideOffset}
		{align}
		class={cn(
			"flex flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 z-50 max-h-(--bits-floating-available-height) w-72 origin-(--bits-floating-transform-origin) overflow-y-auto outline-hidden",
			className
		)}
		{...restProps}
	/>
</PopoverPortal>
