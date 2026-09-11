# Upgrading

Your purchase is a repository, not a package: there is no `bun update` that brings you a new version
of the kit. You pull ours into yours with git, on a branch, and read the diff. This page is the
procedure that makes that bearable — including after you have renamed everything.

Read [`CHANGELOG.md`](CHANGELOG.md) first. It marks what breaks a fork: moved files, renamed exports,
new environment variables, migrations.

## Once, when you start

**Keep the kit's git history.** Clone the kit, then point `origin` at your own empty repository:

```sh
git clone https://github.com/starterdough/starterdough.git my-product
cd my-product
git remote rename origin kit
git remote add origin git@github.com:me/my-product.git
git push -u origin main
```

You now have `kit` as a second remote and a shared ancestor with every future release, which is what
makes a three-way merge possible. If you started from a downloaded archive instead, add the remote
and accept that your first merge needs `--allow-unrelated-histories` and will read as a very large
diff:

```sh
git remote add kit https://github.com/starterdough/starterdough.git
git fetch kit
```

Two habits pay for themselves at every upgrade:

- **Put your code in new files** where you reasonably can — a new route, a new procedure, a new
  package — rather than growing ours. New files never conflict.
- **Do not reformat or reorganise kit files.** Biome is already the arbiter; a whitespace-only change
  to a file we also change turns a clean merge into a manual one.

## Every upgrade

```sh
git fetch kit --tags
git switch -c upgrade/v0.4.0
git merge kit/main            # or: git merge v0.4.0
```

Then, in order:

1. **Resolve conflicts.** Lockfiles are the exception to careful merging: take either side and
   regenerate — `git checkout --theirs bun.lock && bun install`, and let the next
   `bun run build:desktop` refresh `Cargo.lock`.
2. **Diff `.env.example` against your `.env`.** New variables land here first, and a missing one
   usually surfaces as a working-looking deploy that is subtly wrong.
   `git diff HEAD@{1} -- .env.example` shows exactly what changed.
3. **Apply migrations.** `bun run db:migrate` against a copy of production, not production. The
   command checks afterwards that nothing is still pending and **exits 1** when something is, so a
   failed upgrade cannot look like a successful one: Drizzle's migrator compares each file against
   the single newest applied timestamp and permanently skips one that sorts before it — exactly what
   a merge produces. Read the journal (`packages/db/drizzle/meta/_journal.json`), regenerate those
   migrations so they sort last, or apply them by hand. A migration may also fail on purpose rather
   than delete rows to make a new constraint fit; it names the offending key, and its header comment
   carries the query that finds the duplicates.
4. **`bun run verify`.** Lint, typecheck and tests — the same three gates CI runs.
   `bun run licenses --strict` is the fourth, and the one that notices a dependency licence the
   release added that you now have to comply with.
5. **`bun run test:e2e`** if the release touched auth, routing or the app shell.
6. Merge to `main` and deploy as usual.

## After you have renamed the kit

Once you have run `bun run rename`, the kit's files and yours disagree on every occurrence of the
product name, the slug, the workspace scope and the Tauri identifier — and a merge of the next
release will conflict on most of them. The fix is to rename *the kit's* branch the same way before
merging it, so both sides speak your names:

```sh
git fetch kit
git switch -c kit-renamed kit/main
bun run rename --name Acme --slug acme --identifier com.acme.desktop --scope @acme --write
git commit -am "rename kit/main to Acme"

git switch main
git switch -c upgrade/v0.4.0
git merge kit-renamed
```

Use exactly the same arguments you used the first time; the script reads the current values out of
the checkout, so running it on an unrenamed branch produces the same substitutions again. Keep the
`kit-renamed` branch around and repeat the first three commands next time — it makes each upgrade a
normal merge.

The script leaves the kit's own repository URL alone on purpose, which is why `git remote add kit`
keeps working after a rename. It also leaves `LICENSE.md`, `THIRD-PARTY.md`, `CHANGELOG.md` and
`UPGRADING.md` verbatim — they describe the kit, not your product — so those four merge cleanly at
every upgrade.

## What we will not do to you

- **No silent schema changes.** Every schema change ships as a migration file in
  `packages/db/drizzle`, and the changelog says so.
- **No renamed environment variables without a note.** If a variable changes name, the changelog
  lists both.
- **No new required paid service.** Anything that needs a key stays dormant without one, the way
  Stripe, Resend, Sentry, PostHog and the OpenAI-compatible provider already do.

## When an upgrade goes wrong

Nothing here is irreversible: you merged onto a branch, so `git switch main` puts you back. The one
thing that is not on a branch is the database — take a dump before step 3
(`bun run --cwd infra/backup backup`, or `pg_dump` by hand) and you can start the upgrade over.
