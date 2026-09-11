# `@repo/ui`

Shared Svelte 5 components and the Tailwind v4 design tokens every surface renders with — the
SvelteKit app, both Astro sites and the Tauri shells. Consumed **from source**: there is no build
step and no `dist`.

```ts
import { Alert, Button, Dialog, Input, Tooltip } from '@repo/ui';
```

```css
@import "tailwindcss";
@import "@repo/ui/theme.css";
```

Tailwind does not scan `node_modules`, so a consumer must point at this package's source:

```css
@source "../../../../packages/ui/src";
```

## What is exported

`src/index.ts` is the barrel. Two groups, one vocabulary.

**The app's form primitives** — `Alert`, `Button`, `EmptyState`, `FormField`, `Input`, `Label`,
`Select`. `FormField` is the label + control + error/hint block every form in the app is built from;
it hands the control its `id`, `aria-describedby` and `invalid` through a snippet, so the wiring for
assistive technology is written once.
`Button`, `Input` and `Select` are thin wrappers over the shadcn components so only one
implementation, one 32 px size scale and one focus treatment ship (see D23). `Button` maps
`primary | secondary | ghost | danger` onto shadcn's `default | secondary | ghost | destructive` and
`sm | md | lg` onto `sm | default | lg`; `Input`/`Select` map `invalid` onto `aria-invalid`, which is
what the styling keys off. For icon-only buttons, button groups, `outline`/`link` variants or a file
input, import the shadcn component directly:

```ts
import { Button } from '@repo/ui/components/ui/button/index.js';
```

**The shadcn-svelte set** (bits-ui) — `Avatar`, `Badge`, `Card`, `Checkbox`, `Command`, `Dialog`,
`DropdownMenu`, `Popover`, `Separator`, `Sheet`, `Skeleton`, `Switch`, `Tabs`, `Textarea`,
`Toaster`, `Tooltip`, plus `cn`.

## Tooltip needs a provider

`Tooltip.Root` reads a context that `Tooltip.Provider` sets, and throws when it is missing — during
SSR that is a 500, not a blank tooltip. Mount one provider once, around the whole app:

```svelte
<!-- apps/web/src/routes/+layout.svelte -->
<script lang="ts">
	import { TooltipProvider } from '@repo/ui/components/ui/tooltip/index.js';
</script>

<TooltipProvider delayDuration={200}>
	{@render children()}
</TooltipProvider>
```

## Adding a component

```sh
bunx shadcn-svelte@latest add <name> -c packages/ui
```

`components.json` aliases point back at this package (`@repo/ui/utils.js`,
`@repo/ui/components/ui/…`), resolved through the `exports` map at runtime and `tsconfig` `paths`
inside the package, so generated files work unmodified. Then export the component from
`src/index.ts`.

Two things to check after every `add`:

- **It rewrites `catalog:` dependency ranges in `package.json` to literal versions. Restore them** —
  the workspace pins versions in the root catalog, and a literal range here silently forks it.
- Generated files are ours to edit, but keep divergences deliberate and commented; an `add` on the
  same component will overwrite the file.

The registry publishes components only, never their CSS. Six `cn-*` class names in the generated
files (`cn-avatar-group`, `cn-card-action`, `cn-command-item-indicator`,
`cn-input-group-button-size-sm`, `cn-tabs-list-variant-default`, `cn-tabs-list-variant-line`) are
theming hooks that shadcn's own base style leaves empty; only optional style packs define them. Two
of them carried the whole rule they named, so their utilities are written out in the component
instead — see the comments in `input-group-button.svelte` and `tabs-list.svelte`.

## Tokens and contrast

`src/theme.css` defines the un-prefixed variables once as `light-dark()` pairs and maps them in
`@theme inline`. `color-scheme: light dark` makes the page follow the OS with no JavaScript, and
`.light`/`.dark` on `<html>` force a mode (mode-watcher writes those in `apps/web`).

The token set is shadcn's neutral base with the deviations the accessibility gate forces:

| token                | why it differs from shadcn                                            |
| -------------------- | --------------------------------------------------------------------- |
| `--ring`             | shadcn's halves are swapped — light mode is 2.59:1, and SC 1.4.11 wants 3:1 |
| `--sidebar-ring`     | same, and shadcn's dark half is 2.30:1 against `--sidebar`             |
| `--input`            | a control boundary at 1.26:1 / 1.47:1; `--border` stays subtle          |
| `--muted-foreground` | avatar initials on `bg-muted` are 4.34:1 at shadcn's value              |
| `--destructive`      | the tinted danger button is 3.99:1 at shadcn's value                    |
| `--overlay`          | new: the dialog scrim was `bg-black/10`, invisible in dark mode         |
| `--success`/`--warning` | new, with `-foreground` pairs, so no component reaches into raw Tailwind emerald/amber |

Components ring at full alpha, never `ring-ring/50` — at 50% over the background the rendered ring
is 1.96:1 (light) and 2.67:1 (dark) whatever `--ring` is set to.

```sh
bun run --cwd packages/ui test    # scripts/contrast.ts — asserts every ratio above
bun run --cwd packages/ui check   # svelte-check
```

`scripts/contrast.ts` parses `theme.css`, resolves the `light-dark()` pairs and implements
oklch → sRGB → relative luminance itself (no dependencies). axe-core has no focus-contrast rule, so
this script is the only thing that fails when a token drifts.

## Kitchen sink

`apps/web` serves `/dev/ui` in development only: every export rendered in both themes with focus
states visible. Change a token or a variant, look at that page.
