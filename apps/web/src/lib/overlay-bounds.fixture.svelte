<script lang="ts">
	/**
	 * One of `@repo/ui`'s overlays, open, holding more rows than a short window has room for: what
	 * `overlay-bounds.svelte.spec.ts` measures. Not part of the app.
	 */
	import * as Command from '@repo/ui/components/ui/command/index.js';
	import * as DropdownMenu from '@repo/ui/components/ui/dropdown-menu/index.js';
	import * as Popover from '@repo/ui/components/ui/popover/index.js';
	import * as Sheet from '@repo/ui/components/ui/sheet/index.js';

	let {
		overlay,
	}: { overlay: 'submenu' | 'popover' | 'command' | 'sheet-top' | 'sheet-bottom' | 'sheet-right' } =
		$props();

	const rows = Array.from({ length: 40 }, (_, index) => `Row ${index + 1}`);
</script>

{#if overlay === 'submenu'}
	<DropdownMenu.Root open>
		<DropdownMenu.Trigger>Menu</DropdownMenu.Trigger>
		<DropdownMenu.Content>
			<DropdownMenu.Sub open>
				<DropdownMenu.SubTrigger>More</DropdownMenu.SubTrigger>
				<DropdownMenu.SubContent>
					{#each rows as row (row)}
						<DropdownMenu.Item>{row}</DropdownMenu.Item>
					{/each}
				</DropdownMenu.SubContent>
			</DropdownMenu.Sub>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{:else if overlay === 'popover'}
	<Popover.Root open>
		<Popover.Trigger>Open</Popover.Trigger>
		<Popover.Content>
			{#each rows as row (row)}
				<p>{row}</p>
			{/each}
		</Popover.Content>
	</Popover.Root>
{:else if overlay === 'command'}
	<Command.Dialog open title="Palette" description="Rows">
		<Command.Input placeholder="Search" />
		<Command.List>
			{#each rows as row (row)}
				<Command.Item value={row}>{row}</Command.Item>
			{/each}
		</Command.List>
	</Command.Dialog>
{:else}
	<Sheet.Root open>
		<Sheet.Content
			side={overlay === 'sheet-top' ? 'top' : overlay === 'sheet-bottom' ? 'bottom' : 'right'}
		>
			<Sheet.Header>
				<Sheet.Title>Sheet</Sheet.Title>
				<Sheet.Description>Rows</Sheet.Description>
			</Sheet.Header>
			{#each rows as row (row)}
				<p>{row}</p>
			{/each}
		</Sheet.Content>
	</Sheet.Root>
{/if}
