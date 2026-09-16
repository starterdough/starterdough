# Contributing

This is a commercial kit, so most "contributing" happens in your own fork. This page is the dev
loop and the rules that keep your fork mergeable with ours. Bug reports and patches from licensees
are welcome; see the bottom of the page.

## The loop

Follow `QUICKSTART.md` to copy and configure the environment files first. Run `bun run doctor`
before starting the local database; use `bun run doctor -- --database=external` and omit `db:up`
when you intentionally use an existing development database. The
[worked feature example](apps/docs/src/content/docs/guides/feature-example.md) follows a shipped
feature through the database, contract, permissions, localized form and tests.

```sh
bun install                    # installs git hooks and syncs SvelteKit's generated types
bun run db:up                  # Postgres 17 on 127.0.0.1:5433
bun run db:migrate
bun run dev                    # everything, or: dev:app / dev:api / dev:site / dev:docs
```

Before you push:

```sh
bun run verify                 # lint + typecheck + test, in CI's order
```

The pre-push hook runs `bun run verify`. `bun run test:e2e` covers the browser suites (auth,
accessibility, i18n). Run it when you touch routing, forms or the app shell.

Per-package gates are faster while you iterate:

```sh
bun run --cwd apps/web check
bun run --cwd packages/db test
bun run --cwd packages/ui test         # token contrast, recomputed from theme.css
bunx biome check --write <the files you touched>
```

`bun run licenses --strict` is the fourth CI gate. It fails on any dependency licence that is not
written up in `THIRD-PARTY.md`. Run it after adding a dependency and record the verdict there.

## Ground rules

The architecture depends on these. Breaking one is a bug:

- **One API.** A new feature is a contract in `packages/api-contract`, an implementation in
  `apps/api/src/rpc/`, then a typed client call. REST and OpenAPI come with it. Do not add a second
  API or a Tauri IPC data layer.
- **Frontends never import `@repo/db` or `@repo/auth/server`.** Use `@repo/api-client` and
  `@repo/auth/client`.
- **Every user-visible string in `apps/web` is a Paraglide message**, in both `messages/en` and
  `messages/de`, keys sorted. The Astro sites are English only.
- **Internal packages are consumed from source.** No build step, no `dist`.
- **Generated files are regenerated, not edited:** `packages/db/src/schema/auth.ts` (`bun run
  auth:schema`), the Paraglide output, `apps/api/openapi.json`, and `.svelte-kit`.
- **Shared components live in `packages/ui`.** Its README maps every export to the props the app
  uses. `apps/web` serves `/dev/ui` in development: every export in both themes with focus states
  visible. It is a 404 in every build. Check a component change there before shipping it.
- **No new dependency for something a few lines of standard library can do**, and nothing that
  duplicates a decision already recorded in `docs/DECISIONS.md`.

## Style

Biome is the only linter and formatter: tabs, single quotes, 100 columns. It runs on staged files
at pre-commit.

- Comments carry what the code cannot: intent, invariants, constraints, external quirks, the
  ceiling of a deliberate shortcut. No narration.
- No `any`, no `@ts-ignore`, no blanket suppressions. A `biome-ignore` names its rule and its
  reason.
- Tests protect externally observable behaviour and the failure mode you are closing, sized like
  the tests next to them. `bun test` for the TypeScript packages and the API, Vitest (browser mode)
  for Svelte components, Playwright for the end-to-end suites.
- Match the file you are editing.

## Decisions

Anything that constrains future work (a dependency, a boundary, a protocol, a deployment target)
goes in `docs/DECISIONS.md` as a numbered ADR: context, decision, alternatives considered,
consequences. Amend by adding an entry that supersedes the old one; do not rewrite an old one.

Read the existing ADRs before proposing a change to the stack. Most of the obvious alternatives are
in there with the reason they were not taken.

## Commits and pull requests

- One logical change per commit, present tense, scoped like the existing history:
  `feat(api): …`, `fix(web,db): …`, `docs: …`, `chore: …`, `ci: …`.
- A pull request says what changed, why, and how it was verified, with actual command output. The
  template asks for exactly that.
- Note anything a merging fork must do: a migration, a new environment variable, a renamed export.
  Those lines become the changelog entry.

## Reporting a bug in the kit

Open an issue with the bug-report template. Include the version from the root `package.json`, the
package or app, what you expected, what happened, and the smallest reproduction you have. For a
security issue, do not open an issue; see [`SECURITY.md`](SECURITY.md).

Patches are welcome from licensees. By sending one you confirm it is your own work and that it may
ship under the kit's licence.
