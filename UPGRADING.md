# Upgrading

The kit is a repository, not a package. There is no `bun update` for it. You pull a release into
your fork with git, on a branch, and read the diff. This page is that procedure, including after
you have renamed everything.

Read [`CHANGELOG.md`](CHANGELOG.md) first. It marks what breaks a fork: moved files, renamed
exports, new environment variables, migrations.

## Once, when you start

**Keep the kit's git history.** Clone the kit, then point `origin` at your own empty repository:

```sh
git clone https://github.com/starterdough/starterdough.git my-product
cd my-product
git remote rename origin kit
git remote add origin git@github.com:me/my-product.git
git push -u origin main
```

You now have `kit` as a second remote and a shared ancestor with every future release. That is
what makes a three-way merge possible.

If you started from a downloaded archive, add the remote now. Your first merge then needs
`--allow-unrelated-histories` and reads as a very large diff:

```sh
git remote add kit https://github.com/starterdough/starterdough.git
git fetch kit
```

Two habits make every upgrade easier:

- **Put your code in new files** where you can: a new route, a new procedure, a new package. New
  files never conflict.
- **Do not reformat or reorganise kit files.** A whitespace-only change to a file we also change
  turns a clean merge into a manual one.

## Every upgrade

```sh
git fetch kit --tags
git switch -c upgrade/v0.4.0
git merge kit/main            # or: git merge v0.4.0
```

Then, in order:

1. **Resolve conflicts.** For lockfiles, take either side and regenerate:
   `git checkout --theirs bun.lock && bun install`. The next `bun run build:desktop` refreshes
   `Cargo.lock`.
2. **Diff `.env.example` against your `.env`.** New variables land there first.
   `git diff HEAD@{1} -- .env.example` shows what changed.
3. **Apply migrations.** Run `bun run db:migrate` against a copy of production first. The command
   exits 1 when a migration is still pending after the run. Drizzle skips a migration whose
   timestamp sorts before the newest applied one, which a merge can produce. Read the journal
   (`packages/db/drizzle/meta/_journal.json`), regenerate those migrations so they sort last, or
   apply them by hand. A migration may also fail on purpose instead of deleting rows to fit a new
   constraint. It names the offending key, and its header comment carries the query that finds
   the duplicates.
4. **`bun run verify`.** Lint, typecheck and tests, the same three gates CI runs.
   `bun run licenses --strict` is the fourth gate. It notices a dependency licence the release
   added that you now have to comply with.
5. **`bun run test:e2e`** if the release touched auth, routing or the app shell.
6. Merge to `main` and deploy as usual.

## After you have renamed the kit

After `bun run rename`, the kit's files and yours disagree on every occurrence of the product
name, the slug, the workspace scope and the Tauri identifier. A merge of the next release conflicts
on most of them. The fix: rename the kit's branch the same way before merging it.

```sh
git fetch kit
git switch -c kit-renamed kit/main
bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme --write
git commit -am "rename kit/main to Acme"

git switch main
git switch -c upgrade/v0.4.0
git merge kit-renamed
```

Use exactly the same arguments you used the first time. The script reads the current values out
of the checkout, so it produces the same substitutions on an unrenamed branch. Keep the
`kit-renamed` branch and repeat the first three commands next time.

The script leaves the kit's own repository URL alone, so `git remote add kit` keeps working after
a rename. It also leaves `LICENSE.md`, `THIRD-PARTY.md`, `CHANGELOG.md` and `UPGRADING.md` as
they are, so those four merge cleanly at every upgrade.

## Moving to the full edition

This edition is generated from a larger kit by removing the tenant layer and everything built on
it. The full edition adds organizations, teams and workspaces, roles and invitations, an audit
log, Stripe billing per organization, S3-backed documents with storage quotas, a Postgres job
queue and its worker, and a FastAPI service for semantic search and OCR. It is one payment at
[starterdough.dev](https://starterdough.dev). You receive an invitation to the private repository
it is published from.

Moving across is the `--allow-unrelated-histories` case above. This repository is published as a
single commit against an empty history, so it shares no ancestor with the paid one and the first
diff reads as the whole tree. Cloning the paid edition and merging your work onto it is usually
shorter than the reverse.

## What we will not do to you

- **No silent schema changes.** Every schema change ships as a migration file in
  `packages/db/drizzle`, and the changelog says so.
- **No renamed environment variables without a note.** If a variable changes name, the changelog
  lists both.
- **No new required paid service.** Anything that needs a key stays dormant without one, as
  Stripe, Resend, Sentry, PostHog and the OpenAI-compatible provider already do.

## When an upgrade goes wrong

You merged onto a branch, so `git switch main` puts you back. The database is the one thing not
on a branch: take a dump before step 3 (`bun run --cwd infra/backup backup`, or `pg_dump` by
hand) and you can start the upgrade over.
