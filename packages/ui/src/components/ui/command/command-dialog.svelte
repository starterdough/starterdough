<script lang="ts">
	import * as Dialog from '@repo/ui/components/ui/dialog/index.js';
	import { cn, type WithoutChildrenOrChild } from '@repo/ui/utils.js';
	import type { Command as CommandPrimitive, Dialog as DialogPrimitive } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import Command from './command.svelte';

	let {
		open = $bindable(false),
		ref = $bindable(null),
		value = $bindable(''),
		title = 'Command Palette',
		description = 'Search for a command to run...',
		showCloseButton = false,
		portalProps,
		children,
		class: className,
		...restProps
	}: WithoutChildrenOrChild<DialogPrimitive.RootProps> &
		WithoutChildrenOrChild<CommandPrimitive.RootProps> & {
			portalProps?: DialogPrimitive.PortalProps;
			children: Snippet;
			title?: string;
			description?: string;
			showCloseButton?: boolean;
			class?: string;
		} = $props();
</script>

<!--
	It opens a third of the way down, so its height stops a margin short of the window's bottom edge,
	and as a flex column its list, which scrolls, gives up whatever height a short window lacks.
-->
<Dialog.Root bind:open {...restProps}>
	<Dialog.Content
		class={cn(
			"rounded-xl! top-1/3 flex max-h-[calc(66.667%-1rem)] translate-y-0 flex-col overflow-hidden p-0",
			className
		)}
		{showCloseButton}
		{portalProps}
	>
		<!-- Inside the content, not beside it: as a sibling of `Dialog.Content` this header renders
		     into the page itself and every route carries "Command Palette" in its reading order. -->
		<Dialog.Header class="sr-only">
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>{description}</Dialog.Description>
		</Dialog.Header>
		<Command {...restProps} bind:value bind:ref {children} />
	</Dialog.Content>
</Dialog.Root>
