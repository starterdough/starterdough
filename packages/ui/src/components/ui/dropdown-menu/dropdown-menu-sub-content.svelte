<script lang="ts">
	import { cn } from '@repo/ui/utils.js';
	import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DropdownMenuPrimitive.SubContentProps = $props();

	// Diverges from the registry, which sets no height bound: a long submenu ran off the window.
	// `max-h` is the space Floating UI's size middleware leaves, as on the menu itself
	// (`dropdown-menu-content.svelte`), and the items scroll within it.
</script>

<DropdownMenuPrimitive.SubContent
	bind:ref
	data-slot="dropdown-menu-sub-content"
	class={cn("min-w-[96px] rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 w-auto max-h-(--bits-floating-available-height) overflow-x-hidden overflow-y-auto", className)}
	{...restProps}
/>
