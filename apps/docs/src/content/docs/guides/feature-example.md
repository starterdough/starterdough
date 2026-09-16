---
title: Worked feature example
description: A feature flag from shared schema through an admin-only API and a localized browser form.
---

This is the smallest maintained feature to copy when adding a setting that an operator manages and
the app consumes: **feature flags**. It already crosses the contract, API, admin UI, localization,
browser regression and the generated free edition. Start from these files instead of creating a
parallel example domain.

## The path

```text
packages/db  →  packages/api-contract  →  apps/api/src/rpc  →  apps/web admin form  →  $lib/flags
 persistence          schema                   authorization         Superforms           feature gate
```

### 1. Persist the global default

`packages/db/src/schema/flags.ts` defines the durable `feature_flag` row. `packages/db/src/flags.ts`
owns `upsertFlag()`, `deleteFlag()` and the resolved read, so handlers do not repeat database
queries or precedence rules.

The free edition's `packages/db/drizzle/0000_init.sql` creates the global flag table; add a new
migration only when the schema itself changes.

The free edition has only the global `feature_flag` row and resolves that default for everyone.

### 2. Define one input schema in the contract

`packages/api-contract/src/index.ts` owns the key rules and the full upsert input. The contract
uses that exact object for the REST and RPC procedure, and the web client re-exports it from
`@repo/api-client`.

```ts
export const FeatureFlagUpsertInputSchema = z.object({
	key: FlagKeySchema,
	description: z.string().max(200).refine(isSingleLine, controlCharacterRule).optional(),
	enabled: z.boolean().optional(),
});

upsert: adminProcedure
	.route({ method: 'PUT', path: '/admin/flags/{key}', tags: ['admin'] })
	.input(FeatureFlagUpsertInputSchema)
	.output(FeatureFlagSchema),
```

Do not copy the validation rules into a Svelte component. Import the schema through
`@repo/api-client`; the client and server then reject the same key, description and default value.

### 3. Authorize at the API boundary

`apps/api/src/rpc/base.ts` resolves the Better Auth session and checks the account-level platform
role. `apps/api/src/rpc/admin.ts` applies that middleware to every flags procedure, including
reads. Hiding the route in the browser is only a convenience; it is not authorization.

```ts
export const requireAdmin = os.middleware(async ({ context, next }) => {
	const session = await resolveSession(context.headers);
	if (!isAdmin((session.user as { role?: string | null }).role)) throw new ORPCError('FORBIDDEN');
	return next({ context: { session } });
});

export const adminOnly = os.use(requireAdmin);
```


```ts
upsert: adminOnly.admin.flags.upsert.handler(async ({ input }) => {
	return upsertFlag(input);
}),
```


### 4. Use the shared Superforms adapter in the browser

`apps/web/src/routes/(admin)/admin/flags/+page.svelte` initializes the form with the contract
schema. `$lib/forms.ts` supplies the standard SPA options and `zodForm()`, which maps Zod issues to
Paraglide messages at validation time. `FormField` connects the label, error, invalid state and
description for each input.

```svelte
const create = superForm(
	defaults({ key: '', description: '', enabled: false }, zodForm(FeatureFlagUpsertInputSchema)),
	{
		...spaForm,
		validators: zodForm(FeatureFlagUpsertInputSchema),
		async onUpdate({ form }) {
			if (!form.valid) return;
			const { key, description, enabled } = form.data;
			const { error, data: flag } = await safe(
				api.admin.flags.upsert({ key, description: description?.trim(), enabled }),
			);
			if (error) return setError(form, messageOf(error));
			put(flag);
		},
	},
);
```

The complete form trims the optional description before it sends it, blocks duplicate keys in its
already-loaded list, keeps input on a failed request and resets only after a successful submission.
Use the complete source for those details rather than this shortened excerpt.

### 5. Read the resolved value where it changes behavior

`apps/web/src/lib/flags.ts` exposes the one reactive read every component uses:

```svelte
{#if flag('release-notes')}
	<ReleaseNotes />
{/if}
```

The `(app)` layout loads the global default for the deployment.

`flagsFor()` returns an empty map when the API is unreachable. A gated feature is therefore off
until the server can resolve it.

## Run the walkthrough

1. Complete the [Quickstart install and environment setup](/start/quickstart/#install-and-run), then
   start the local database, apply the existing migration history and run the app:

   ```sh
   bun run doctor
   bun run db:up
   bun run db:migrate
   bun run dev:app
   ```

2. Create a platform administrator as described in [Admin](/guides/admin/#bootstrap), sign in,
   and open `http://localhost:5173/admin/flags`.
3. Enter `Release Notes` as a key and submit. The browser must show the localized lowercase-slug
   validation error and make no request to create a flag.
4. Enter `release-notes`, add a description and submit. The list should immediately contain the
   new flag; use the toggle to change its global default.
5. Sign in as an ordinary `user` account and request `/api/v1/admin/flags` with that account's
   session. It must receive `403 FORBIDDEN`; a client-side redirect or hidden admin navigation does
   not count as the check.

6. The free edition has one global default, so every signed-in user sees the same value.

## What the automated checks cover

| Check | Evidence | Boundary |
| --- | --- | --- |
| Browser form regression | `apps/web/src/lib/admin-flags-page.svelte.spec.ts` submits an invalid key, a successful create and a rejected request. | It runs the real Svelte component in Chromium and mocks only the typed API client. It proves browser validation, translated error rendering, pending submission behavior and retained input; it does not persist a database row. |
| API authorization regression | `apps/api/src/rpc/admin-authorization.test.ts` calls the real `requireAdmin` middleware as an authenticated `user`. | Better Auth session lookup is replaced with that fixed non-admin session so the test proves it answers `FORBIDDEN` before a database handler runs. `apps/api/src/app.test.ts` separately checks that anonymous admin routes answer `401`. |

Run the focused checks from the repository root:

```sh
cd apps/web && bunx vitest --run src/lib/admin-flags-page.svelte.spec.ts
cd ../.. && SKIP_ENV_VALIDATION=1 bun test apps/api/src/rpc/admin-authorization.test.ts
```

For a release, the free edition is generated from this source and passes its own verification. Keep
cross-edition code and prose shared where possible; put paid-only behavior inside the established
