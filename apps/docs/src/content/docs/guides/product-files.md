---
title: Where your code goes
description: The product files the kit creates once and never changes, so that a kit release merges without touching your code.
---

A kit release reaches your repository as a git merge (`UPGRADING.md`), and a merge conflicts
wherever both sides changed the same lines. So each place your product plugs into the kit is a
file of its own, next to the kit code that reads it. The kit created each of these files in 1.1.0
as an empty stub, and no release changes one afterwards: what you add there never conflicts. A
later extension point arrives as a new file.

## The product files

| What you add | Your file | Read by |
| --- | --- | --- |
| Tables | `packages/db/src/schema/product.ts` | `packages/db/src/client.ts` and `drizzle.config.ts` |
| Query helpers | `packages/db/src/product.ts` | `packages/db/src/index.ts`, so they import from `@repo/db` |
| Migrations | `packages/db/drizzle-product/`, generated | `bun run db:migrate`, after the kit's |
| Procedures, and the schemas clients share | `packages/api-contract/src/product.ts` | the contract, and `@repo/api-client`, which re-exports the whole file |
| Handlers | `apps/api/src/rpc/product.ts` | `apps/api/src/rpc/router.ts` |
| Email templates, in English and German | `packages/email/src/product.ts` | `templates` in `@repo/email`, next to the kit's |
| Messages, in English and German | `apps/web/messages/{en,de}/product.json` | Paraglide, as `m.product_<page>_<element>()` |
| Links in the navigation and the command palette | `apps/web/src/lib/product.ts` | the app shell, before Settings |
| Release notes, one file per release | `apps/site/src/content/changelog/` | the site's `/changelog` |
| Blog posts, one file per post | `apps/site/src/content/blog/` | the site's `/blog` and `/rss.xml` |
| Documentation for your users | `apps/docs/src/content/product/` | the docs build, which publishes it by default |
| Steps of your own before and after each deploy, one `*.sh` per step | `infra/scripts/hooks/pre-deploy.d/` and `post-deploy.d/` | `infra/scripts/deploy.sh`, in name order (`infra/scripts/hooks/README.md`) |

The rest of a feature goes in new files of yours, which never conflict either: a schema file
exported from `schema/product.ts`, a contract file spread into `productContract`, a router added
to `productRouter`, its pages under `apps/web/src/routes/`, and their tests.

Some of these files have a guide of their own:

- Email templates: [Adding a template](/guides/authentication/#adding-a-template).

Three rules keep these files working:

- **Import the kit's modules, never the file that imports yours.** The contract's `index.ts`
  imports `product.ts`, so a contract file of yours builds on `./procedures`, which holds the
  builders and the text rules, never on `./index`.
  A query helper imports `./client` and `./schema`, never `./index`. Importing back is a cycle
  that fails at start-up.
- **Names of your own.** The contract and the router take your entries after the kit's, and a key
  the kit already uses fails `bun run check`.
- **The kit never names a file of its own `product.ts`, `product-*.ts` or `product.json`**, and
  never adds to `drizzle-product/`, the site's `changelog/` and `blog/`, `src/content/product/` or
  the two deploy hook folders. Anything with such a name or in such a folder is yours.

## Contract and handlers

A procedure is declared in the contract and implemented once, as the kit's are, with a `route` so
that it is also REST under `/api/v1` and in the OpenAPI document:

```ts
// packages/api-contract/src/product.ts
import { z } from 'zod';
import { protectedProcedure } from './procedures';

export const ReportSchema = z.object({ id: z.string(), title: z.string() });
export type Report = z.infer<typeof ReportSchema>;

export const productContract = {
	reports: {
		list: protectedProcedure
			.route({ method: 'GET', path: '/reports', tags: ['reports'], summary: 'Your reports' })
			.output(z.array(ReportSchema)),
	},
};
```

```ts
// apps/api/src/rpc/product.ts
import { listReports } from '@repo/db';
import { authed } from './base';

export const productRouter = {
	reports: {
		list: authed.reports.list.handler(({ context }) => listReports(context.session.user.id)),
	},
};
```

`bun run check` fails while a procedure in `productContract` has no handler in `productRouter`.
The web app imports `ReportSchema` and `Report` from `@repo/api-client` like any kit export, and
calls `api.reports.list()`. A kit export with the same name as one of yours wins there, without an
error, so name yours apart.

## Database: two migration histories

The kit's migrations are `packages/db/drizzle`; yours are `packages/db/drizzle-product`, each with
its own history table. `bun run db:generate` writes yours from what `schema/product.ts` exports,
and `bun run db:migrate` applies the kit's history, then yours. A kit release that adds a migration
therefore never touches yours. `UPGRADING.md` ("Migrations") covers the order on fresh and existing
databases, and what to do when `db:migrate` reports one still pending.

A table of yours can reference a kit table: import the kit table into your schema file, and never
re-export it, or `db:generate` creates it a second time.

## The kit's tables

Rather than adding a column to a kit table, add a table of your own keyed by its id, such as
`user_profile (user_id primary key references "user")`. It gets its migration from a plain
`bun run db:generate`, and kit releases never touch it.

When a kit table itself has to change (a Better Auth plugin after `bun run auth:schema`, an index
of yours on a kit table), `bun run db:kit-drift` prints the SQL your schema needs that none of your
migrations holds yet. Put it in `bun run db:generate --custom --name=<name>` and check that it drops
nothing. `bun run test` fails while any of it is outstanding.

## Messages and navigation

Your messages go in `apps/web/messages/en/product.json` and `apps/web/messages/de/product.json`,
keys sorted, named `product_<page>_<element>`. The i18n test fails while a key is in one language
only.

A link in the sidebar, the mobile menu and the command palette is an entry in `productNavLinks`.
Its label is the message function itself, which the shell calls as it renders, so it follows the
user's language:

```ts
// apps/web/src/lib/product.ts
import FileTextIcon from '@lucide/svelte/icons/file-text';
import { m } from '#lib/paraglide/messages.js';

export const productNavLinks: ProductLink[] = [
	{ href: '/app/reports', label: m.product_nav_reports, icon: FileTextIcon, keywords: ['pdf'] },
];
```


## The site's posts and your docs

The kit wrote one sample into each content folder in 1.1.0: a draft release note
(`changelog/first-release.md`), a draft post (`blog/welcome.md`), and a splash page and a getting
started guide in `apps/docs/src/content/product`. A draft (`draft: true`) shows in
`bun run dev:site` and is left out of every build, the feed and the sitemap. Rewrite or delete the
samples: no release adds or changes a file in these folders, and the kit's own release notes stay
in `CHANGELOG.md`.

A page you add under `apps/docs/src/content/product/guides/` or `reference/` appears in the docs
sidebar by itself, so `astro.config.mjs` needs no edit. These pages, the kit's manual, live in
`apps/docs/src/content/docs`, which `bun run dev:manual` serves and no deploy publishes.

## Versions

The root `package.json` has two version fields. `version` is your product's: the kit ships 0.1.0
and never changes it again, and it is what `/api/v1/health`, the OpenAPI document and OpenTelemetry
report. `kitVersion` is the kit release your repository is on, shown on `/admin/system`; only kit
releases change it, so never edit it yourself.

## What still means editing a kit file

A few changes have no product file, because they change how the kit itself behaves. Keep each one
small and leave the lines around it as they are, so that a release changing the same file merges
cleanly or stops only on your lines:

- Better Auth's configuration: plugins, providers and fields in `packages/auth/src/server.ts`.
- The self-hosted stack: Caddy's routes and the Compose files in `infra/`. Steps a deploy should run
  go in the hook folders above, not in `deploy.sh`.
