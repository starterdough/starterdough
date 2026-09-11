# Contributing

This is a commercial kit, so "contributing" mostly means *working in your own fork* — and this page
is the loop we use, written down so your fork stays mergeable with ours. Bug reports and patches from
licensees are welcome; see the bottom of the page.

## The loop

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

`bun run verify` is what the pre-push hook runs. Skip it once with `LEFTHOOK=0 git push` when you
know why. `bun run test:e2e` covers the browser suites (auth, accessibility, i18n) and needs the app
running; run it when you touch routing, forms or the app shell.

Per-package gates are faster while you iterate:

```sh
bun run --cwd apps/web check
bun run --cwd packages/db test
bun run --cwd packages/ui test         # token contrast, recomputed from theme.css
bunx biome check --write <the files you touched>
```

`bun run licenses --strict` is the fourth CI gate: it fails on any dependency licence that is not
already written up in `THIRD-PARTY.md`, so run it after adding a dependency and record the verdict
there.

## Ground rules

These are the constraints the architecture depends on. Breaking one is not a style disagreement, it
is a bug:

- **One API.** A new feature is a contract in `packages/api-contract`, an implementation in
  `apps/api/src/rpc/`, then a typed client call. REST and OpenAPI come free. Do not add a second API
  or a Tauri IPC data layer.
- **Frontends never import `@repo/db` or `@repo/auth/server`.** Only `@repo/api-client` and
  `@repo/auth/client`.
- **Every user-visible string in `apps/web` is a Paraglide message**, in both `messages/en` and
  `messages/de`, keys sorted. The Astro sites are English only.
- **Internal packages are consumed from source.** No build step, no `dist`.
- **Generated files are regenerated, not edited:** `packages/db/src/schema/auth.ts` (`bun run
  auth:schema`), the Paraglide output, `apps/api/openapi.json`, and `.svelte-kit`.
- **Shared components live in `packages/ui`.** Its README maps every export to the props the app
  uses, and `apps/web` serves `/dev/ui` in development — every export in both themes with focus
  states visible, a 404 in every build. Check a component change there before shipping it.
- **No new dependency for something a few lines of standard library can do**, and nothing that
  duplicates a decision already recorded in `docs/DECISIONS.md`.

## Style

Biome is the only linter and formatter: tabs, single quotes, 100 columns. It runs on staged files at
pre-commit, so you rarely have to think about it.

- Comments carry what the code cannot: intent, invariants, constraints, external quirks, the ceiling
  of a deliberate shortcut. Not narration.
- No `any`, no `@ts-ignore`, no blanket suppressions. A `biome-ignore` names its rule and its reason.
- Tests protect externally observable behaviour and the failure mode you are closing, sized like the
  tests next to them. `bun test` for the TypeScript packages and the API, Vitest (browser mode) for
  Svelte components, Playwright for the end-to-end suites.
- Match the file you are editing. Finish the pattern the repo is moving toward rather than the one it
  is leaving.

## Decisions

Anything that constrains future work — a dependency, a boundary, a protocol, a deployment target —
goes in `docs/DECISIONS.md` as a numbered ADR: context, decision, alternatives considered,
consequences. Amend by adding an entry that supersedes the old one; do not rewrite an old one.

Read the existing ADRs before proposing a change to the stack. Most of the obvious alternatives are
in there with the reason they were not taken.

## Commits and pull requests

- One logical change per commit, present tense, scoped like the existing history:
  `feat(api): …`, `fix(web,db): …`, `docs: …`, `chore: …`, `ci: …`.
- A pull request says what changed, why, and how it was verified — actual command output, not
  "tests pass". The template asks for exactly that.
- Note anything a merging fork must do: a migration, a new environment variable, a renamed export.
  Those lines become the changelog entry.

## Reporting a bug in the kit

Open an issue with the bug-report template. Include the version from the root `package.json`, the
package or app, what you expected, what happened, and the smallest reproduction you have. If it is a
security issue, do not open an issue — see [`SECURITY.md`](SECURITY.md).

Patches are welcome from licensees. By sending one you confirm it is your own work and you are happy
for it to ship under the kit's licence.
