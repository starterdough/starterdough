// The app's form vocabulary (Button variants primary/secondary/ghost/danger, `invalid` on fields).
// `Button`, `Input` and `Select` are thin wrappers over the shadcn components, so there is one
// implementation, one 32 px scale and one focus treatment in the bundle. See README.md for the
// prop mapping. `Alert`, `EmptyState` and `Label` have no shadcn counterpart here.
export { default as Alert } from './components/Alert.svelte';
export { default as Button } from './components/Button.svelte';
export { default as EmptyState } from './components/EmptyState.svelte';
export { default as FormField } from './components/FormField.svelte';
export { default as Input } from './components/Input.svelte';
export { default as Label } from './components/Label.svelte';
export { default as Select } from './components/Select.svelte';

// shadcn-svelte components (bits-ui). Add more with
// `bunx shadcn-svelte@latest add <name> -c packages/ui`, then export them here.
// shadcn's own button/input/input-group are not re-exported: the wrappers above are the barrel's
// API; import `@repo/ui/components/ui/button/index.js` for icon sizes, `outline` or `link`.
export * as Avatar from './components/ui/avatar/index.js';
export { Badge, badgeVariants } from './components/ui/badge/index.js';
export * as Card from './components/ui/card/index.js';
export { Checkbox } from './components/ui/checkbox/index.js';
export * as Command from './components/ui/command/index.js';
export * as Dialog from './components/ui/dialog/index.js';
export * as DropdownMenu from './components/ui/dropdown-menu/index.js';
export * as Popover from './components/ui/popover/index.js';
export { Separator } from './components/ui/separator/index.js';
export * as Sheet from './components/ui/sheet/index.js';
export { Skeleton } from './components/ui/skeleton/index.js';
export { Toaster } from './components/ui/sonner/index.js';
export { Switch } from './components/ui/switch/index.js';
export * as Tabs from './components/ui/tabs/index.js';
export { Textarea } from './components/ui/textarea/index.js';
export * as Tooltip from './components/ui/tooltip/index.js';
export { MOTION_MS, slideFade } from './motion.js';
export { cn } from './utils.js';
