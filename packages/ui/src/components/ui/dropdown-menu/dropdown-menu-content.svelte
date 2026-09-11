<script lang="ts">
	import { cn, type WithoutChildrenOrChild } from '@repo/ui/utils.js';
	import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';
	import type { ComponentProps } from 'svelte';
	import DropdownMenuPortal from './dropdown-menu-portal.svelte';

	let {
		ref = $bindable(null),
		sideOffset = 4,
		align = 'start',
		portalProps,
		class: className,
		...restProps
	}: DropdownMenuPrimitive.ContentProps & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DropdownMenuPortal>>;
	} = $props();

	// Sizing diverges from the registry: it ships `w-(--bits-dropdown-menu-anchor-width)`, a variable
	// bits-ui only sets for select/combobox/menubar, so a menu on an icon-button trigger had a dead
	// width declaration and no height bound. `min-w-32` plus the floating wrapper's own
	// `min-width: max-content` sizes the menu to its longest item, and `max-h` uses the generic
	// variable bits-ui does set (Floating UI's size middleware) so a long menu scrolls in place.
</script>

<DropdownMenuPortal {...portalProps}>
	<DropdownMenuPrimitive.Content
		bind:ref
		data-slot="dropdown-menu-content"
		{sideOffset}
		{align}
		class={cn(
			"min-w-32 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 z-50 max-h-(--bits-floating-available-height) overflow-x-hidden overflow-y-auto outline-none data-[state=closed]:overflow-hidden",
			className
		)}
		{...restProps}
	/>
</DropdownMenuPortal>
