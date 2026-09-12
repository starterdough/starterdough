<!--
Keep this short and factual. The verification output and the note for forks matter most: those two
become the changelog entry.
-->

## What changed

<!-- One or two sentences. What behaviour is different now? -->

## Why

<!-- The bug, the issue number, or the requirement. Link it. -->

## How it was verified

<!--
Actual output, not "tests pass". The commands you ran and what they said:

    bun run verify
    bun run --cwd apps/api test        # 41 pass, 0 fail
    bun run test:e2e                   # 12 passed

If a gate was skipped, say which and why.
-->

## Notes for forks

<!--
Anything a buyer merging this must do. Delete the lines that do not apply:

- Migration: `bun run db:migrate` (`packages/db/drizzle/0008_….sql`)
- New environment variable: `FOO_BAR` (default `…`; documented in `.env.example`)
- Renamed export: `oldName` → `newName` in `@repo/…`
- Breaking contract change: …
-->

## Checklist

- [ ] `bun run verify` passes locally.
- [ ] New user-visible strings in `apps/web` are Paraglide messages in `en` and `de`.
- [ ] A decision that constrains future work is recorded in `docs/DECISIONS.md`.
- [ ] `.env.example` documents any new variable, with its default.
- [ ] The changelog's `Unreleased` section covers this if a buyer would notice it.
- [ ] No new dependency, or the pull request says why one was unavoidable.
