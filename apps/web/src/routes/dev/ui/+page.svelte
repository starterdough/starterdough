<script lang="ts">
	import SearchIcon from '@lucide/svelte/icons/search';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import {
		Alert,
		Avatar,
		Badge,
		Button,
		Card,
		Checkbox,
		Command,
		Dialog,
		DropdownMenu,
		EmptyState,
		Input,
		Label,
		Popover,
		Select,
		Separator,
		Sheet,
		Skeleton,
		Switch,
		Tabs,
		Textarea,
		Tooltip,
	} from '@repo/ui';
	import * as InputGroup from '@repo/ui/components/ui/input-group/index.js';

	// Deliberately not translated: this page never reaches a user (see +page.ts) and mirroring 80
	// component labels into every locale would cost more than it tells anyone.

	let checked = $state(true);
	let switched = $state(true);
	let text = $state('');
	let choice = $state('b');
	let dialogOpen = $state(false);
	let sheetOpen = $state(false);

	const tokens = [
		'background',
		'foreground',
		'card',
		'popover',
		'primary',
		'secondary',
		'muted',
		'accent',
		'destructive',
		'success',
		'warning',
		'border',
		'input',
		'ring',
		'overlay',
	];
</script>

<svelte:head><title>@repo/ui kitchen sink</title></svelte:head>

{#snippet swatches()}
	<div class="grid grid-cols-3 gap-2 sm:grid-cols-5">
		{#each tokens as token (token)}
			<div class="flex flex-col gap-1">
				<div
					class="border-border h-10 rounded-md border"
					style="background-color: var(--{token})"
				></div>
				<code class="text-muted-foreground text-[0.7rem]">--{token}</code>
			</div>
		{/each}
	</div>
{/snippet}

{#snippet catalogue()}
	<div class="bg-background text-foreground flex flex-col gap-8 rounded-lg p-6">
		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold tracking-wide uppercase">Tokens</h2>
			{@render swatches()}
		</section>

		<Separator />

		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold tracking-wide uppercase">Button</h2>
			<p class="text-muted-foreground text-xs">
				Tab through these: the ring must be visible against the panel in both themes. Note that
				ghost is the only one invisible at rest — that is the whole difference between it and
				outline, and why a standalone action in a row takes outline.
			</p>
			<div class="flex flex-wrap items-center gap-2">
				<Button>primary</Button>
				<Button variant="secondary">secondary</Button>
				<Button variant="outline">outline</Button>
				<Button variant="ghost">ghost</Button>
				<Button variant="danger">danger</Button>
				<Button disabled>disabled</Button>
				<Button href="/dev/ui">as a link</Button>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<Button size="sm">sm</Button>
				<Button size="md">md</Button>
				<Button size="lg">lg</Button>
				<Button variant="secondary" size="sm">
					<SettingsIcon aria-hidden="true" />
					with icon
				</Button>
			</div>
		</section>

		<Separator />

		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold tracking-wide uppercase">Form controls</h2>
			<div class="grid gap-4 sm:grid-cols-2">
				<Label>
					Input
					<Input bind:value={text} placeholder="placeholder" />
				</Label>
				<Label>
					Input, invalid
					<Input invalid value="not an email" />
				</Label>
				<Label>
					Input, disabled
					<Input disabled value="disabled" />
				</Label>
				<Label>
					Select — the chevron must not touch the text
					<Select bind:value={choice}>
						<option value="a">A short option</option>
						<option value="b">An option long enough to reach the chevron</option>
					</Select>
				</Label>
				<Label>
					Textarea
					<Textarea placeholder="placeholder" rows={3} />
				</Label>
				<div class="flex flex-col gap-3">
					<Label class="flex-row items-center gap-2">
						<Checkbox bind:checked />
						Checkbox
					</Label>
					<Label class="flex-row items-center gap-2">
						<Switch bind:checked={switched} />
						Switch
					</Label>
				</div>
			</div>
			<InputGroup.Root>
				<InputGroup.Addon>
					<SearchIcon aria-hidden="true" />
				</InputGroup.Addon>
				<InputGroup.Input placeholder="InputGroup with a sm button" />
				<InputGroup.Addon align="inline-end">
					<InputGroup.Button size="sm">Search</InputGroup.Button>
				</InputGroup.Addon>
			</InputGroup.Root>
		</section>

		<Separator />

		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold tracking-wide uppercase">Alert</h2>
			<Alert>info</Alert>
			<Alert variant="success">success</Alert>
			<Alert variant="warning">warning</Alert>
			<Alert variant="error">error</Alert>
		</section>

		<Separator />

		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold tracking-wide uppercase">Badge, Avatar, Skeleton</h2>
			<div class="flex flex-wrap items-center gap-2">
				<Badge>default</Badge>
				<Badge variant="secondary">secondary</Badge>
				<Badge variant="outline">outline</Badge>
				<Badge variant="destructive">destructive</Badge>
			</div>
			<div class="flex items-center gap-3">
				<Avatar.Root>
					<Avatar.Fallback>DK</Avatar.Fallback>
				</Avatar.Root>
				<Avatar.Group>
					<Avatar.Root><Avatar.Fallback>AB</Avatar.Fallback></Avatar.Root>
					<Avatar.Root><Avatar.Fallback>CD</Avatar.Fallback></Avatar.Root>
					<Avatar.GroupCount>+3</Avatar.GroupCount>
				</Avatar.Group>
				<Skeleton class="h-8 w-32" />
			</div>
		</section>

		<Separator />

		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold tracking-wide uppercase">Tabs</h2>
			<Tabs.Root value="one">
				<Tabs.List>
					<Tabs.Trigger value="one">default</Tabs.Trigger>
					<Tabs.Trigger value="two">variant</Tabs.Trigger>
				</Tabs.List>
				<Tabs.Content value="one" class="pt-3 text-sm">Filled track.</Tabs.Content>
				<Tabs.Content value="two" class="pt-3 text-sm">Filled track, second panel.</Tabs.Content>
			</Tabs.Root>
			<Tabs.Root value="one">
				<Tabs.List variant="line">
					<Tabs.Trigger value="one">line</Tabs.Trigger>
					<Tabs.Trigger value="two">underlined</Tabs.Trigger>
				</Tabs.List>
				<Tabs.Content value="one" class="pt-3 text-sm">
					`variant="line"` — no track, an underline on the active tab.
				</Tabs.Content>
				<Tabs.Content value="two" class="pt-3 text-sm">Second panel.</Tabs.Content>
			</Tabs.Root>
		</section>

		<Separator />

		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold tracking-wide uppercase">Card and EmptyState</h2>
			<Card.Root>
				<Card.Header>
					<Card.Title>Card title</Card.Title>
					<Card.Description>Card description.</Card.Description>
					<Card.Action>
						<Button variant="ghost" size="sm">Action</Button>
					</Card.Action>
				</Card.Header>
				<Card.Content class="text-sm">Content.</Card.Content>
				<Card.Footer><Button size="sm">Footer button</Button></Card.Footer>
			</Card.Root>
			<EmptyState title="Nothing here yet" description="What an EmptyState looks like.">
				{#snippet icon()}
					<TrashIcon />
				{/snippet}
				{#snippet action()}
					<Button size="sm">Create one</Button>
				{/snippet}
			</EmptyState>
		</section>

		<Separator />

		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold tracking-wide uppercase">Overlays</h2>
			<p class="text-muted-foreground text-xs">
				These portal to `document.body`, so they follow the page theme rather than this panel.
			</p>
			<div class="flex flex-wrap items-center gap-2">
				<Button variant="secondary" size="sm" onclick={() => (dialogOpen = true)}>Dialog</Button>
				<Button variant="secondary" size="sm" onclick={() => (sheetOpen = true)}>Sheet</Button>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button variant="secondary" size="sm" {...props}>DropdownMenu</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end">
						<DropdownMenu.Item>A short item</DropdownMenu.Item>
						<DropdownMenu.Item
							>An item long enough to prove the menu is not clipped</DropdownMenu.Item
						>
						<DropdownMenu.Separator />
						<DropdownMenu.Item>Third</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
				<Popover.Root>
					<Popover.Trigger>
						{#snippet child({ props })}
							<Button variant="secondary" size="sm" {...props}>Popover</Button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content>
						<Popover.Header>
							<Popover.Title>Popover</Popover.Title>
							<Popover.Description>With a title and a description.</Popover.Description>
						</Popover.Header>
					</Popover.Content>
				</Popover.Root>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button variant="secondary" size="sm" {...props}>Tooltip</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Needs the provider in the root layout.</Tooltip.Content>
				</Tooltip.Root>
			</div>
			<Command.Root class="max-w-sm">
				<Command.Input placeholder="Command palette" />
				<Command.List>
					<Command.Empty>No results.</Command.Empty>
					<Command.Group heading="Group">
						<Command.Item>First item</Command.Item>
						<Command.Item>Second item</Command.Item>
					</Command.Group>
				</Command.List>
			</Command.Root>
		</section>
	</div>
{/snippet}

<div class="mx-auto flex max-w-6xl flex-col gap-6 p-6">
	<header class="flex flex-col gap-1">
		<h1 class="text-2xl font-semibold">@repo/ui kitchen sink</h1>
		<p class="text-muted-foreground text-sm">
			Every export, forced light on the left and forced dark on the right (`.light` / `.dark`
			wrappers — nested sections may force a scheme, see <code>@repo/ui/theme.css</code>).
			Development only.
		</p>
	</header>

	<div class="grid gap-6 xl:grid-cols-2">
		<div class="light border-border rounded-xl border">{@render catalogue()}</div>
		<div class="dark border-border rounded-xl border">{@render catalogue()}</div>
	</div>
</div>

<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Dialog</Dialog.Title>
			<Dialog.Description>
				The scrim behind this is `--overlay`; it has to be visible in dark mode too.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}
					<Button variant="ghost" {...props}>Cancel</Button>
				{/snippet}
			</Dialog.Close>
			<Button variant="danger">Confirm</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Sheet.Root bind:open={sheetOpen}>
	<Sheet.Content>
		<Sheet.Header>
			<Sheet.Title>Sheet</Sheet.Title>
			<Sheet.Description>Its trigger and close carry `type="button"`.</Sheet.Description>
		</Sheet.Header>
		<div class="px-4">
			<Sheet.Close>
				{#snippet child({ props })}
					<Button variant="secondary" {...props}>Close</Button>
				{/snippet}
			</Sheet.Close>
		</div>
	</Sheet.Content>
</Sheet.Root>
